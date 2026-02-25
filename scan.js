// mdns-scan.js
// 用法: node mdns-scan.js
// 说明: 监听本地 mDNS 流量并主动做 DNS-SD 枚举（IPv4）
// 需要 Node.js 18+（建议用最新 LTS）

import dgram from "node:dgram";
import os from "node:os";

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

const TYPE = {
	A: 1,
	PTR: 12,
	TXT: 16,
	AAAA: 28,
	SRV: 33,
	ANY: 255
};

const CLASS_IN = 1;

const knownServiceTypes = new Set();
const queriedNames = new Set();

function labelsToName(name) {
	return name.endsWith('.') ? name : `${name}.`;
}

function encodeName(name) {
	const fqdn = labelsToName(name);
	const parts = fqdn.split('.').filter(Boolean);
	const out = [];
	for (const p of parts) {
		const b = Buffer.from(p, 'utf8');
		if (b.length > 63) {
			throw new Error(`label too long: ${p}`);
		}
		out.push(Buffer.from([b.length]));
		out.push(b);
	}
	out.push(Buffer.from([0]));
	return Buffer.concat(out);
}

function buildQueryPacket({id = 0, questions = []}) {
	// 标准 DNS 头 12 字节
	const header = Buffer.alloc(12);
	header.writeUInt16BE(id & 0xffff, 0);     // ID（mDNS 中通常忽略）
	header.writeUInt16BE(0x0000, 2);          // Flags = query
	header.writeUInt16BE(questions.length, 4); // QDCOUNT
	header.writeUInt16BE(0, 6);               // ANCOUNT
	header.writeUInt16BE(0, 8);               // NSCOUNT
	header.writeUInt16BE(0, 10);              // ARCOUNT

	const qbufs = [];
	for (const q of questions) {
		qbufs.push(encodeName(q.name));
		const tail = Buffer.alloc(4);
		tail.writeUInt16BE(q.type, 0);
		tail.writeUInt16BE(q.class || CLASS_IN, 2);
		qbufs.push(tail);
	}

	return Buffer.concat([header, ...qbufs]);
}

function readName(buf, offset, depth = 0) {
	if (depth > 20) {
		throw new Error('DNS name compression too deep');
	}

	const labels = [];
	let pos = offset;
	let consumed = 0;
	let jumped = false;

	while (true) {
		if (pos >= buf.length) {
			throw new Error('readName out of bounds');
		}
		const len = buf[pos];

		// pointer: 11xxxxxx xxxxxxxx
		if ((len & 0xc0) === 0xc0) {
			if (pos + 1 >= buf.length) {
				throw new Error('bad compression pointer');
			}
			const ptr = ((len & 0x3f) << 8) | buf[pos + 1];
			if (!jumped) {
				consumed += 2;
			}
			const rec = readName(buf, ptr, depth + 1);
			labels.push(rec.name.replace(/\.$/, ''));
			pos += 2;
			jumped = true;
			break;
		}

		if (len === 0) {
			if (!jumped) {
				consumed += 1;
			}
			pos += 1;
			break;
		}

		const start = pos + 1;
		const end = start + len;
		if (end > buf.length) {
			throw new Error('label out of bounds');
		}

		labels.push(buf.slice(start, end).toString('utf8'));
		pos = end;
		if (!jumped) {
			consumed += 1 + len;
		}
	}

	return {
		name: labels.filter(Boolean).join('.') + '.',
		bytes: consumed
	};
}

function parseTXT(rdata) {
	const out = [];
	let i = 0;
	while (i < rdata.length) {
		const n = rdata[i];
		i += 1;
		if (i + n > rdata.length) {
			break;
		}
		out.push(rdata.slice(i, i + n).toString('utf8'));
		i += n;
	}
	return out;
}

function parseIPv6(buf) {
	const parts = [];
	for (let i = 0; i < 16; i += 2) {
		parts.push(buf.readUInt16BE(i).toString(16));
	}
	return parts.join(':').replace(/\b:?(?:0:){2,}/, '::');
}

function parseRRData(type, rdata, fullBuf, rdataOffset) {
	try {
		switch (type) {
			case TYPE.A:
				if (rdata.length !== 4) {
					return {raw: rdata.toString('hex')};
				}
				return {address: `${rdata[0]}.${rdata[1]}.${rdata[2]}.${rdata[3]}`};

			case TYPE.AAAA:
				if (rdata.length !== 16) {
					return {raw: rdata.toString('hex')};
				}
				return {address: parseIPv6(rdata)};

			case TYPE.PTR: {
				const n = readName(fullBuf, rdataOffset);
				return {ptrdname: n.name};
			}

			case TYPE.SRV: {
				if (rdata.length < 6) {
					return {raw: rdata.toString('hex')};
				}
				const priority = rdata.readUInt16BE(0);
				const weight = rdata.readUInt16BE(2);
				const port = rdata.readUInt16BE(4);
				const target = readName(fullBuf, rdataOffset + 6).name;
				return {priority, weight, port, target};
			}

			case TYPE.TXT:
				return {txt: parseTXT(rdata)};

			default:
				return {raw: rdata.toString('hex')};
		}
	} catch (e) {
		return {parseError: String(e.message || e), raw: rdata.toString('hex')};
	}
}

function parsePacket(buf) {
	if (buf.length < 12) {
		throw new Error('packet too short');
	}

	const header = {
		id: buf.readUInt16BE(0),
		flags: buf.readUInt16BE(2),
		qd: buf.readUInt16BE(4),
		an: buf.readUInt16BE(6),
		ns: buf.readUInt16BE(8),
		ar: buf.readUInt16BE(10)
	};

	let off = 12;

	const questions = [];
	for (let i = 0; i < header.qd; i++) {
		const qn = readName(buf, off);
		off += qn.bytes;
		if (off + 4 > buf.length) {
			throw new Error('question tail out of bounds');
		}
		const qtype = buf.readUInt16BE(off);
		const qclass = buf.readUInt16BE(off + 2);
		off += 4;
		questions.push({name: qn.name, type: qtype, class: qclass});
	}

	function parseRRSection(count) {
		const arr = [];
		for (let i = 0; i < count; i++) {
			const nn = readName(buf, off);
			off += nn.bytes;
			if (off + 10 > buf.length) {
				throw new Error('RR header out of bounds');
			}

			const type = buf.readUInt16BE(off);
			const rrclass = buf.readUInt16BE(off + 2);
			const ttl = buf.readUInt32BE(off + 4);
			const rdlen = buf.readUInt16BE(off + 8);
			off += 10;

			const rdataOffset = off;
			const rdataEnd = off + rdlen;
			if (rdataEnd > buf.length) {
				throw new Error('RDATA out of bounds');
			}
			const rdata = buf.slice(rdataOffset, rdataEnd);

			const data = parseRRData(type, rdata, buf, rdataOffset);
			off = rdataEnd;

			arr.push({
				name: nn.name,
				type,
				class: rrclass & 0x7fff,
				cacheFlush: Boolean(rrclass & 0x8000),
				ttl,
				data
			});
		}
		return arr;
	}

	const answers = parseRRSection(header.an);
	const authorities = parseRRSection(header.ns);
	const additionals = parseRRSection(header.ar);

	return {header, questions, answers, authorities, additionals};
}

function rrTypeName(t) {
	return Object.entries(TYPE).find(([, v]) => v === t)?.[0] || `TYPE${t}`;
}

function logRR(prefix, rr) {
	const base = `${prefix} ${rr.name} ${rrTypeName(rr.type)} ttl=${rr.ttl}`;
	const d = rr.data;

	if (d.ptrdname) {
		console.log(`${base} -> ${d.ptrdname}`);
	} else if (d.address) {
		console.log(`${base} -> ${d.address}`);
	} else if (d.port !== undefined) {
		console.log(`${base} -> ${d.target}:${d.port} (pri=${d.priority}, w=${d.weight})`);
	} else if (d.txt) {
		console.log(`${base} -> TXT ${JSON.stringify(d.txt)}`);
	} else {
		console.log(`${base} -> ${JSON.stringify(d)}`);
	}
}

function sendPTRQuery(sock, name) {
	const fqdn = labelsToName(name);
	if (queriedNames.has(fqdn)) {
		return;
	}
	queriedNames.add(fqdn);

	const packet = buildQueryPacket({
		questions: [{name: fqdn, type: TYPE.PTR, class: CLASS_IN}]
	});

	sock.send(packet, MDNS_PORT, MDNS_ADDR, (err) => {
		if (err) {
			console.error(`[send query error] ${fqdn}`, err.message);
		} else {
			console.log(`\n[QUERY] PTR ${fqdn}`);
		}
	});
}

function getIPv4Interfaces() {
	const nets = os.networkInterfaces();
	const out = [];
	for (const [ifname, addrs] of Object.entries(nets)) {
		for (const a of addrs || []) {
			if (a.family === 'IPv4' && !a.internal) {
				out.push({ifname, address: a.address});
			}
		}
	}
	return out;
}

function main() {
	const sock = dgram.createSocket({type: 'udp4', reuseAddr: true});

	sock.on('error', (err) => {
		console.error('[socket error]', err);
	});

	sock.on('message', (msg, rinfo) => {
		let pkt;
		try {
			pkt = parsePacket(msg);
		} catch (e) {
			console.error(`[parse error] from ${rinfo.address}:${rinfo.port}:`, e.message);
			return;
		}

		const isQuery = (pkt.header.flags & 0x8000) === 0;
		const qr = isQuery ? 'Q' : 'R';
		console.log(`\n[${qr}] ${rinfo.address}:${rinfo.port} len=${msg.length} qd=${pkt.header.qd} an=${pkt.header.an} ns=${pkt.header.ns} ar=${pkt.header.ar}`);

		for (const q of pkt.questions) {
			console.log(`  ? ${q.name} ${rrTypeName(q.type)}`);
		}

		for (const rr of [...pkt.answers, ...pkt.authorities, ...pkt.additionals]) {
			logRR('  *', rr);

			// 如果是服务类型枚举返回的 PTR（_services._dns-sd._udp.local -> _http._tcp.local）
			if (
				rr.type === TYPE.PTR &&
				rr.name.toLowerCase() === '_services._dns-sd._udp.local.' &&
				rr.data?.ptrdname
			) {
				const serviceType = rr.data.ptrdname.toLowerCase();
				if (!knownServiceTypes.has(serviceType)) {
					knownServiceTypes.add(serviceType);
					console.log(`    [+] 发现服务类型: ${serviceType}`);
					// 继续枚举这个服务类型下的实例
					sendPTRQuery(sock, serviceType);
				}
			}
		}
	});

	sock.bind(MDNS_PORT, () => {
		try {
			sock.addMembership(MDNS_ADDR);
			sock.setMulticastTTL(255); // mDNS 常用 hop limit/TTL 255
			sock.setMulticastLoopback(true);
		} catch (e) {
			console.error('[multicast setup error]', e.message);
		}

		const ifs = getIPv4Interfaces();
		console.log('[mDNS listener started]');
		console.log(`  bind: 0.0.0.0:${MDNS_PORT}`);
		console.log(`  multicast: ${MDNS_ADDR}:${MDNS_PORT}`);
		console.log(`  interfaces: ${ifs.map(i => `${i.ifname}(${i.address})`).join(', ') || '(none)'}`);

		// 先做服务类型枚举（RFC 6763 Section 9）
		sendPTRQuery(sock, '_services._dns-sd._udp.local');

		// 可选：顺便查询常见服务类型（加快看到结果）
		setTimeout(() => sendPTRQuery(sock, '_http._tcp.local'), 500);
		setTimeout(() => sendPTRQuery(sock, '_ipp._tcp.local'), 700);
		setTimeout(() => sendPTRQuery(sock, '_airplay._tcp.local'), 900);
		setTimeout(() => sendPTRQuery(sock, '_googlecast._tcp.local'), 1100);
	});

	process.on('SIGINT', () => {
		console.log('\n[exit]');
		try { sock.close(); } catch {}
		process.exit(0);
	});
}

main();