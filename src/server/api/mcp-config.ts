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
 * @param serverName MCP server name shown in the client (default "roster"). The portal passes the client's
 *   brand (e.g. "brandlord-team") so white-label clients never see ours; env var names follow it.
 */
export function mcpConfigSnippet(
  baseUrl: string,
  keyPlaceholder = "rk_live_YOUR_KEY",
  serverName = "roster",
): McpSnippets {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/mcp`;
  const name =
    serverName
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()
      .slice(0, 48) || "roster";
  // ROSTER_* for the default name (unchanged for existing setups); BRANDLORD_TEAM_* for a branded one.
  const envName = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const authVar = `${envName}_AUTH_HEADER`;
  const keyVar = `${envName}_API_KEY`;
  const claudeCode = `claude mcp add --transport http ${name} ${url} --header "Authorization: Bearer ${keyPlaceholder}"`;
  const claudeDesktop = JSON.stringify(
    {
      mcpServers: {
        [name]: {
          command: "npx",
          args: [
            "-y",
            "mcp-remote@latest",
            url,
            "--header",
            `Authorization:\${${authVar}}`,
          ],
          env: { [authVar]: `Bearer ${keyPlaceholder}` },
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
    `bearer_token_env_var = "${keyVar}"`,
    ``,
    `# then: export ${keyVar}="${keyPlaceholder}"`,
  ].join("\n");
  const generic = JSON.stringify(
    {
      type: "http",
      url,
      headers: { Authorization: `Bearer ${keyPlaceholder}` },
    },
    null,
    2,
  );
  return { url, claudeCode, claudeDesktop, codex, generic };
}
