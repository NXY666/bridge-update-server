import {Octokit} from '@octokit/rest';

/**
 * GitHub API 客户端，封装请求与速率限制状态管理。
 */
export class GithubClient {
	/** @type {import('@octokit/rest').Octokit|null} */
	#_octokit = null;

	/** @type {number} */
	#rateLimitRemaining = Infinity;

	/** @type {number} */
	#rateLimitReset = 0;

	/**
	 * 懒加载的 Octokit 实例。
	 * @returns {import('@octokit/rest').Octokit}
	 */
	get #octokit() {
		if (!this.#_octokit) {
			this.#_octokit = new Octokit();
		}
		return this.#_octokit;
	}

	/**
	 * 剩余请求配额。
	 * @type {number}
	 */
	get rateLimitRemaining() {
		return this.#rateLimitRemaining;
	}

	/**
	 * 速率限制重置时间（Unix 秒）。
	 * @type {number}
	 */
	get rateLimitReset() {
		return this.#rateLimitReset;
	}

	/**
	 * 从响应头中更新速率限制状态。
	 * @param {Record<string, string>} headers 响应头
	 */
	#updateRateLimitFromHeaders(headers) {
		const remaining = parseInt(headers['x-ratelimit-remaining'] ?? '', 10);
		const reset = parseInt(headers['x-ratelimit-reset'] ?? '', 10);
		if (!isNaN(remaining)) {
			this.#rateLimitRemaining = remaining;
		}
		if (!isNaN(reset)) {
			this.#rateLimitReset = reset;
		}
	}

	/**
	 * 设置 Token，验证通过后生效；返回 Token 是否有效。
	 * @param {string} token GitHub 个人访问令牌
	 * @returns {Promise<boolean>} Token 是否有效
	 */
	async setToken(token) {
		const octokit = new Octokit({auth: token});
		while (true) {
			try {
				const {headers} = await octokit.rest.users.getAuthenticated();
				this.#_octokit = octokit;
				this.#updateRateLimitFromHeaders(headers);
				return true;
			} catch (err) {
				if (err.response?.headers?.['x-ratelimit-remaining'] === '0') {
					const reset = parseInt(err.response.headers['x-ratelimit-reset'], 10);
					const waitMs = Math.max(reset * 1000 - Date.now() + 1000, 1000);
					console.warn('[GitHub]', '设置 Token 时触发速率限制，等待重置', 'waitMs=', waitMs);
					await new Promise(r => setTimeout(r, waitMs));
					continue;
				}
				if (err.status === 401) {
					return false;
				}
				throw err;
			}
		}
	}

	/**
	 * 获取最新 Release 原始数据，并同步更新速率限制状态。
	 * @param {string} owner 仓库所有者
	 * @param {string} repo 仓库名称
	 * @returns {Promise<object>} Release 原始数据
	 */
	async getLatestRelease(owner, repo) {
		try {
			const {data: release, headers} = await this.#octokit.rest.repos.getLatestRelease({owner, repo});
			this.#updateRateLimitFromHeaders(headers);
			return release;
		} catch (err) {
			if (err.response?.headers) {
				this.#updateRateLimitFromHeaders(err.response.headers);
			}
			throw err;
		}
	}
}
