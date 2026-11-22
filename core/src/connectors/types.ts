import type { z } from "zod";
import type { Tool } from "../tools/types.ts";

/** A value the user types into the Connectors page, such as an API key or an OAuth client ID. */
export interface ConnectorField {
  key: string;
  label: string;
  /** Secret values are never sent back to the UI, only a masked form. */
  secret?: boolean;
  required?: boolean;
  help?: string;
  placeholder?: string;
}

export interface OAuthConfig {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Extra query parameters for the sign-in URL. */
  params?: Record<string, string>;
  /** Field keys holding the client ID and secret (default clientId / clientSecret). */
  clientIdField?: string;
  clientSecretField?: string;
  /** Optional URL returning the signed-in account (JSON with email or name). */
  userInfoUrl?: string;
  revokeUrl?: string;
}

export interface ConnectorManifest {
  id: string;
  name: string;
  description: string;
  /** Lucide icon name shown on the card. */
  icon?: string;
  auth: "none" | "apiKey" | "oauth2";
  fields: ConnectorField[];
  oauth?: OAuthConfig;
  /**
   * How connector.fetch() authenticates for apiKey connectors, e.g.
   * { header: "Authorization", value: "Bearer {apiKey}" } or { query: "key", value: "{apiKey}" }.
   */
  apiKeyAuth?: { header?: string; query?: string; value: string };
  /** apiKey connectors: a URL that returns the signed-in account (checked when keys change; a 401 marks the key as rejected). */
  accountUrl?: string;
  /** Headers every call needs (e.g. GitHub's Accept and User-Agent). */
  headers?: Record<string, string>;
  /** Step-by-step setup for the user, in Markdown. */
  setup?: string;
  builtin?: boolean;
  createdBy?: "agent" | "user" | "syph";
}

/** What a connector's tools get: its settings and a fetch that is already signed in. */
export interface ConnectorRuntime {
  id: string;
  /** A field value the user saved (API key, base URL, ...). */
  get(key: string): string | undefined;
  /** fetch() with the connector's auth applied (OAuth token refreshed as needed, or the API key). */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** fetch() that returns parsed JSON (or text) and throws a readable error on failure. */
  json<T = any>(url: string, init?: Omit<RequestInit, "body"> & { body?: any }): Promise<T>;
}

export interface ConnectorModule {
  tools: Tool[];
  test?: () => Promise<void> | void;
}

export type ConnectorFactory = (syph: { z: typeof z; defineTool: <S extends z.ZodType>(t: Tool<S>) => Tool<S> }, connector: ConnectorRuntime) => ConnectorModule | Promise<ConnectorModule>;

export interface ConnectorStatus {
  id: string;
  name: string;
  description: string;
  icon?: string;
  auth: ConnectorManifest["auth"];
  builtin: boolean;
  createdBy?: string;
  enabled: boolean;
  /** needs_setup: required fields missing; needs_signin: OAuth not done; ready; error. */
  state: "needs_setup" | "needs_signin" | "ready" | "error";
  error?: string;
  account?: string;
  fields: (ConnectorField & { set: boolean; value?: string })[];
  tools: { name: string; description: string; permission: string }[];
  setup?: string;
}
