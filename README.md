# OMP Jev MCP Ranker

An [Oh My Pi](https://github.com/can1357/oh-my-pi) extension that ranks MCP tools against the current user prompt with [TypeSafe Jev](https://typesafe.ai/). It gives the main agent up to five likely tools without disabling anything else.

## Install

```sh
omp plugin install github:hopletstudio/omp-jev-mcp-ranker
```

Restart OMP after installation.

Requires OMP 18.2.6 or newer and a TypeSafe API key.

## Set up

1. Run `/mcp-ranker key` and press Enter. OMP opens its masked TypeSafe login prompt and stores the key in its own credential store.
2. Run `/mcp-ranker`, choose **watched MCP servers**, and save.
3. Run `/mcp-ranker status` to check the setup.

`TYPESAFE_API_KEY` also works if you prefer an environment variable.

## What it does

For each submitted prompt, the extension:

1. collects active tools from the watched MCP servers;
2. asks Jev whether the request needs MCP and scores each candidate tool;
3. keeps the five highest scores at or above `0.50`;
4. adds those names, descriptions, and scores to that turn as hidden advisory context.

Jev is pinned to `jev-1.13.0`. A missing key, API error, malformed response, or four-second timeout leaves the normal OMP flow unchanged.

## Privacy

Each ranking request sends TypeSafe:

- the current submitted prompt;
- active tool names and descriptions from watched MCP servers;
- the fixed ranking questions.

It does not send conversation history, tool schemas, tool results, files, or images. TypeSafe states that customer requests and responses are not used for training; see its [model data-handling notes](https://docs.typesafe.ai/models#data-handling).

The watched-server list lives in `mcp-tool-ranker.json` under the active OMP agent directory. API keys stay in OMP's credential store and are never written to that file.

## Commands

| Command | Action |
|---|---|
| `/mcp-ranker` | Open the setup menu |
| `/mcp-ranker configure` | Choose watched MCP servers |
| `/mcp-ranker key` | Open OMP's masked TypeSafe login |
| `/mcp-ranker status` | Show watched servers and key status |

## Development

```sh
bun run selfcheck
omp --no-extensions -e ./src/mcp-tool-ranker.ts
```

The self-check covers server-name parsing, score filtering, and ranking order.

## License

MIT
