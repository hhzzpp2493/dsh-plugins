import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
const WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE = "web-search-tavily";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { WebError } from "@deepseek-ai/dsh-web";

/**
 * Tavily-backed search provider for the DeepSeek Harness web capability seam
 * (`ctx.web`). It calls Tavily's dedicated `/search` retrieval endpoint
 * (`POST {baseURL}/search`) with the shared API key, and maps Tavily's
 * structured `results[]` into the seam's normalized `WebSearchSource` shape.
 * A pure retrieval endpoint, so one search is one lightweight HTTP call (unlike
 * the DeepSeek provider, which costs a full model turn).
 *
 * @module @deepseek-ai/dsh-web-search-tavily
 */

/** Stable id this provider registers under. */
const TAVILY_PROVIDER_ID = "tavily";

/** Default Tavily API base URL; `/search` is appended. */
const TAVILY_DEFAULT_BASE_URL = "https://api.tavily.com";

/** Default result count requested from Tavily when the tool sets none. */
const TAVILY_DEFAULT_MAX_RESULTS = 5;

/** Default retrieval depth: `basic` is the fast, cheaper search. */
const TAVILY_DEFAULT_SEARCH_DEPTH = "basic";

/** Attribution header sent on every request. */
const USER_AGENT = "deepseek-harness/0.0.1";

/**
 * Map a Tavily `/search` response body to the seam's normalized result shape.
 * `answer` (when the request asked for it) becomes `content`; each `results[]`
 * item maps to a `WebSearchSource` with Tavily's `content` as the snippet and
 * `published_date` as `publishedAt`. The web service owns the final
 * `maxResults` truncation, so `truncated` is always `false` here.
 *
 * @param body - the parsed Tavily search response.
 * @returns the normalized result.
 */
function mapTavilyResponse(body) {
	const sources = [];
	for (const item of body.results ?? []) {
		if (item.url == null || item.url.length === 0) continue;
		sources.push({
			url: item.url,
			...item.title != null && item.title.length > 0 ? { title: item.title } : {},
			...item.content != null && item.content.length > 0 ? { snippet: item.content } : {},
			...item.published_date != null && item.published_date.length > 0 ? { publishedAt: item.published_date } : {}
		});
	}
	return {
		...body.answer != null && body.answer.length > 0 ? { content: body.answer } : {},
		sources,
		truncated: false
	};
}

/** The Tavily-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
var TavilySearchProvider = class {
	resolveOptions;
	id = TAVILY_PROVIDER_ID;
	/**
	 * @param resolveOptions - options for the NEXT operation, snapshotted once
	 * at each operation's entry so one search never mixes two sections.
	 */
	constructor(resolveOptions) {
		this.resolveOptions = resolveOptions;
	}

	available() {
		const options = this.resolveOptions();
		return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== void 0) && URL.canParse(options.baseURL);
	}

	async search(request, signal) {
		const options = this.resolveOptions();
		const apiKey = await this.apiKey(options, signal);
		throwIfSearchAborted(signal);
		const endpoint = `${options.baseURL.replace(/\/+$/u, "")}/search`;
		const body = {
			api_key: apiKey,
			query: request.query,
			search_depth: options.searchDepth,
			include_answer: true,
			include_raw_content: false,
			include_images: false,
			max_results: request.maxResults ?? options.maxResults
		};
		options.recordRequest?.({
			endpoint,
			searchDepth: options.searchDepth,
			maxResults: body.max_results,
			queryPreview: request.query.slice(0, 200)
		});
		throwIfSearchAborted(signal);
		let response;
		try {
			response = await fetch(endpoint, {
				method: "POST",
				redirect: "error",
				headers: {
					"content-type": "application/json",
					"accept": "application/json",
					"user-agent": USER_AGENT
				},
				body: JSON.stringify(body),
				...signal !== void 0 ? { signal } : {}
			});
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw new WebError(`Tavily search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (!response.ok) {
			let message = `Tavily API error (HTTP ${response.status})`;
			try {
				const parsed = await response.json();
				const detail = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message;
				if (detail !== void 0 && detail.length > 0) message = detail;
			} catch (error) {
				if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			}
			throw new WebError(message, "WEB_PROVIDER_ERROR");
		}
		try {
			return mapTavilyResponse(await response.json());
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw new WebError(`Tavily returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
	}

	/**
	 * Resolve one operation's credential without retaining it on the provider.
	 * @param options - the caller's snapshot, so the key travels with the endpoint.
	 * @param signal - abort signal for the surrounding search.
	 * @returns the resolved Tavily key.
	 */
	async apiKey(options, signal) {
		throwIfSearchAborted(signal);
		if (options.apiKey !== void 0 && options.apiKey.length > 0) return options.apiKey;
		let resolved;
		try {
			resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(void 0), signal);
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw new WebError(`Tavily search credential resolution failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (resolved !== void 0 && resolved.length > 0) return resolved;
		throw new WebError(`Tavily search has no API key for "${options.apiKeyEnv ?? "TAVILY_API_KEY"}"; store it through the credentials service, export it in the launching environment, or set a literal "apiKey" in the web-search-tavily config`, "WEB_PROVIDER_CREDENTIAL_MISSING");
	}
};

/**
 * Race a same-process asynchronous preflight against caller cancellation. The
 * attached settlement handlers keep observing an uncooperative operation after
 * abort so a later rejection cannot become unhandled.
 */
function abortable(operation, signal) {
	if (signal === void 0) return operation;
	if (signal.aborted) return Promise.reject(searchAborted(signal));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			reject(searchAborted(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then((value) => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", onAbort);
			reject(new Error(String(error).replace(/^Error: /u, ""), { cause: error }));
		});
	});
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal) {
	if (signal?.aborted === true) throw searchAborted(signal);
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal, fallback) {
	return new WebError("Tavily search aborted", "WEB_ABORTED", { cause: signal?.aborted === true ? signal.reason : fallback });
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}

//#region plugin
/** Cordis plugin name used by loader diagnostics. */
const name = "web-search-tavily";

/** The web seam this provider registers into. */
const inject = ["web"];

const DEFAULT_API_KEY_ENV = "TAVILY_API_KEY";

const Config = z.object({
	apiKey: z.string().role("secret"),
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
	baseURL: z.string().default(TAVILY_DEFAULT_BASE_URL),
	searchDepth: z.union([z.const("basic"), z.const("advanced")]).default(TAVILY_DEFAULT_SEARCH_DEPTH),
	maxResults: z.number().step(1).min(1).default(TAVILY_DEFAULT_MAX_RESULTS)
});

/** Settings namespace carrying this provider's endpoint, depth, and key reference. */

/**
 * Project one resolved section into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(ctx, config) {
	const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV);
	const literalApiKey = config.apiKey !== void 0 && config.apiKey.length > 0 ? config.apiKey : void 0;
	return {
		...literalApiKey === void 0 ? {} : { apiKey: literalApiKey },
		resolveApiKey: async () => {
			const credentials = ctx.get("credentials");
			if (credentials !== void 0) return (await credentials.resolve(apiKeyEnv))?.value;
			const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv);
			return ambient !== void 0 && ambient.value.length > 0 ? ambient.value : void 0;
		},
		apiKeyEnv,
		baseURL: config.baseURL ?? TAVILY_DEFAULT_BASE_URL,
		searchDepth: config.searchDepth ?? TAVILY_DEFAULT_SEARCH_DEPTH,
		maxResults: config.maxResults ?? TAVILY_DEFAULT_MAX_RESULTS,
		recordRequest: (request) => {
			ctx.get("agents")?.currentInitiator()?.session.append("web/tavily-search-request", request);
		}
	};
}

/** Register the Tavily search provider with `ctx.web`. */
function apply(ctx, config) {
	let current = () => config;
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE, Config, config, {
		setSource: (source) => {
			current = source;
		},
			onChange: () => {}
		});
	});
	ctx.web.registerSearchProvider(new TavilySearchProvider(() => resolveOptions(ctx, current())));
}
//#endregion

export {
	Config,
	TAVILY_DEFAULT_BASE_URL,
	TAVILY_DEFAULT_MAX_RESULTS,
	TAVILY_DEFAULT_SEARCH_DEPTH,
	TAVILY_PROVIDER_ID,
	TavilySearchProvider,
	WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE,
	apply,
	inject,
	name
};
