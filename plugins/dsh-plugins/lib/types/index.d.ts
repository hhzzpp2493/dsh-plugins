import { Context } from "@deepseek-ai/cordis";
import type { WebSearchProvider } from "@deepseek-ai/dsh-web";

export declare const TAVILY_PROVIDER_ID: "tavily";
export declare const TAVILY_DEFAULT_BASE_URL: string;
export declare const TAVILY_DEFAULT_MAX_RESULTS: number;
export declare const TAVILY_DEFAULT_SEARCH_DEPTH: "basic" | "advanced";
export declare const WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE: unknown;

export declare const Config: import("@deepseek-ai/schemastery").Type<{
	apiKey?: string;
	apiKeyEnv: string;
	baseURL: string;
	searchDepth: "basic" | "advanced";
	maxResults: number;
}>;

export declare class TavilySearchProvider implements WebSearchProvider {
	readonly id: string;
	constructor(resolveOptions: () => TavilyResolvedOptions);
	available(): boolean;
	search(request: { query: string; maxResults?: number }, signal?: AbortSignal): Promise<import("@deepseek-ai/dsh-web").WebSearchResult>;
	apiKey(options: TavilyResolvedOptions, signal?: AbortSignal): Promise<string>;
}

interface TavilyResolvedOptions {
	readonly apiKey?: string;
	readonly resolveApiKey?: () => Promise<string | undefined>;
	readonly apiKeyEnv: string;
	readonly baseURL: string;
	readonly searchDepth: "basic" | "advanced";
	readonly maxResults: number;
	readonly recordRequest?: (request: unknown) => void;
}

export declare const name: "web-search-tavily";
export declare const inject: ["web"];
export declare function apply(ctx: Context, config: unknown): void;
