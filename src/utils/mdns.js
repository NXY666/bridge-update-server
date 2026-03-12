import ciao from '@homebridge/ciao';
import {Bonjour} from 'bonjour-service';
import {randomUUID} from 'node:crypto';

/**
 * mDNS 服务管理器，支持服务广播与局域网对等节点发现。
 */
export class MdnsService {
	/** @type {string} */
	#serviceName;

	/** @type {string} */
	#serviceType;

	/** @type {string} */
	#instanceId;

	/** @type {import('bonjour-service').Bonjour|null} */
	#bonjourInstance = null;

	/** @type {import('@homebridge/ciao').Responder|null} */
	#ciaoResponder = null;

	/** @type {import('@homebridge/ciao').CiaoService|null} */
	#publishedService = null;

	/**
	 * @param {object} options
	 * @param {string} options.serviceName 服务名称
	 * @param {string} options.serviceType mDNS 服务类型（如 `http`）
	 */
	constructor({serviceName, serviceType}) {
		this.#serviceName = serviceName;
		this.#serviceType = serviceType;
		this.#instanceId = randomUUID();
	}

	/**
	 * 当前实例的唯一 ID，用于在发现时过滤自身。
	 * @type {string}
	 */
	get instanceId() {
		return this.#instanceId;
	}

	/**
	 * 以指定端口及附加 txt 记录广播服务。
	 * @param {number} port 服务端口
	 * @param {Record<string, string>} [txt={}] 附加 TXT 记录
	 * @returns {Promise<void>}
	 */
	async advertise(port, txt = {}) {
		this.#bonjourInstance = new Bonjour();
		this.#ciaoResponder = ciao.getResponder();

		this.#publishedService = this.#ciaoResponder.createService({
			name: this.#serviceName,
			type: this.#serviceType,
			port,
			txt: {instance: this.#instanceId, ...txt}
		});
		await this.#publishedService.advertise();

		console.log('[mDNS]', '服务已发布', 'type=', this.#serviceType, 'port=', port);
	}

	/**
	 * 扫描局域网内同类型的其它服务实例，返回原始 bonjour service 对象列表。
	 * @param {number} [timeout=10000] 扫描超时时间（毫秒）
	 * @returns {Promise<import('bonjour-service').Service[]>} 发现的对等节点列表
	 */
	discover(timeout = 10000) {
		return new Promise((resolve) => {
			if (!this.#bonjourInstance) {
				resolve([]);
				return;
			}

			const peers = [];
			const browser = this.#bonjourInstance.find({type: this.#serviceType});

			browser.on('up', (service) => {
				// 过滤自身
				if (service.txt?.instance === this.#instanceId) {
					return;
				}
				peers.push(service);
			});

			setTimeout(() => {
				browser.stop();
				resolve(peers);
			}, timeout);
		});
	}
}
