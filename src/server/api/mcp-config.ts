/**
 * Copy-paste MCP client configuration for a client's AI employee.
 * Pure (no server imports) so client components can import it too.
 */
export type McpSnippets = {
  url: string;
  claudeCode: string;
  claudeDesktop: string;
  codex: string;
  /** Generic: any MCP client that speaks streamable HTTP with a bearer header. */
  generic: string;
};

/**
 * @param baseUrl e.g. "https://app.roster.ai" (APP_URL)
 * @param keyPlaceholder what to show where the key goes, e.g. "rk_live_ab12…" (never pass a raw key you
 *   don't intend to display)
 * @param serverName MCP server name shown in the client (default "roster")
 */
export function mcpConfigSnippet(baseUrl: string, keyPlaceholder = "rk_live_YOUR_KEY", serverName = "roster"): McpSnippets {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/mcp`;
  const name = serverName.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase() || "roster";
  const claudeCode = `claude mcp add --transport http ${name} ${url} --header "Authorization: Bearer ${keyPlaceholder}"`;
  const claudeDesktop = JSON.stringify(
    {
      mcpServers: {
        [name]: {
          command: "npx",
          args: ["-y", "mcp-remote@latest", url, "--header", "Authorization:${ROSTER_AUTH_HEADER}"],
          env: { ROSTER_AUTH_HEADER: `Bearer ${keyPlaceholder}` },
        },
      },
    },
    null,
    2,
  );
  const codex = [
    `# ~/.codex/config.toml`,
    `[mcp_servers.${name}]`,
    `url = "${url}"`,
    `bearer_token_env_var = "ROSTER_API_KEY"`,
    ``,
    `# then: export ROSTER_API_KEY="${keyPlaceholder}"`,
  ].join("\n");
  const generic = JSON.stringify({ type: "http", url, headers: { Authorization: `Bearer ${keyPlaceholder}` } }, null, 2);
  return { url, claudeCode, claudeDesktop, codex, generic };
}
