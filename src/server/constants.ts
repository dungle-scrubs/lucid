/** The loopback port the browser surface binds to (RFC-06). Never a wildcard bind. */
export const SERVER_PORT = 17454;

/** Custom header carrying the session token. A custom header forces a preflight for cross-origin requests. */
export const TOKEN_HEADER = "x-lucid-token";
