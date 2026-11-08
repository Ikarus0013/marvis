# Marvis

Marvis is a Slack slash command server that uses Claude to classify a command and send it to a Zapier webhook.

## What it does

- Marvis gets a Slack slash command (for example `/marvis blog about AI trends`).
- Marvis checks the Slack request signature.
- Marvis sends a short reply to Slack in less than 3 seconds.
- Marvis asks Claude to put the command into one of three flows: `blog`, `linkedin`, or `text_response`.
- For `blog` and `linkedin`, Marvis sends the data to a Zapier webhook.
- For `text_response`, Marvis posts a message back to the Slack channel.

## Requirements

- macOS, Linux, or Windows.
- Node.js 18 or later, and npm.
- A Slack app with a slash command. You must have permission to install the app in your workspace.
- An Anthropic API account and an API key.
- A Zapier account with two "Catch Hook" webhooks (one for blog, one for LinkedIn).
- A public HTTPS URL for your server, for example from a tunnel tool such as ngrok.

## Install

1. Get the code.

   ```bash
   git clone https://github.com/Ikarus0013/marvis.git
   cd marvis
   ```

2. Install the dependencies.

   ```bash
   npm install
   ```

3. Copy the example configuration file.

   ```bash
   cp .env.example .env
   ```

4. Open `.env` and replace each placeholder with your value.

## Configure

Marvis reads its configuration from environment variables. Marvis also reads a `.env` file in the project folder.

| Variable | Required | Description |
| --- | --- | --- |
| `SLACK_SIGNING_SECRET` | Yes | Signing secret of your Slack app. Marvis uses it to check each request. |
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key. |
| `ZAPIER_LINKEDIN_WEBHOOK` | Yes | Zapier webhook URL for the `linkedin` flow. |
| `ZAPIER_BLOG_WEBHOOK` | Yes | Zapier webhook URL for the `blog` flow. |
| `ANTHROPIC_MODEL` | No | Claude model for the routing call. Default is `claude-sonnet-5`. |
| `PORT` | No | TCP port for the server. Default is `3000`. |

If a required variable is missing, Marvis shows an error and stops.

**CAUTION:** Do not commit the `.env` file. It contains secrets. The `.gitignore` file excludes it.

## Use

1. Start the server.

   ```bash
   npm start
   ```

2. Make sure that the server runs.

   ```bash
   curl http://localhost:3000/health
   ```

   The server replies `Server is running`.

3. Make your local port available on a public HTTPS URL.

   ```bash
   ngrok http 3000
   ```

4. In the Slack app settings, open **Slash Commands**.
5. Set the **Request URL** of your command to `https://<your-public-host>/slack-handler`.
6. In Slack, type a command.

   ```text
   /marvis schedule a LinkedIn post for tomorrow at 9am about our product launch
   ```

Example result: Claude selects the `linkedin` flow. Marvis sends this JSON to the LinkedIn webhook:

```json
{
  "post_content": "product launch",
  "details": "tomorrow at 9am",
  "user_id": "U0123456",
  "user_name": "jane",
  "team_domain": "example"
}
```

The `blog` flow sends `blog_title` in place of `post_content`.

## How it works

1. Express gets the `POST /slack-handler` request and keeps the raw body.
2. Marvis calculates an HMAC SHA-256 signature with the signing secret. Marvis compares it with the `X-Slack-Signature` header.
3. Marvis rejects requests that are older than 5 minutes.
4. Marvis sends an immediate reply to Slack. Then it continues the work in the background.
5. Marvis calls the Anthropic Messages API with one tool, `route_command`. The tool output gives `flow_name`, `primary_content`, and `details`.
6. If the Claude call fails, Marvis uses the `text_response` flow.

## Files

| File | Description |
| --- | --- |
| `server.js` | The complete server: signature check, Claude routing, webhook calls. |
| `package.json` | Package data and dependencies. |
| `.env.example` | Example configuration with placeholders. |
| `LICENSE` | MIT license. |

## Limits

- The `text_response` flow does not generate an answer. It only posts the classification back to Slack.
- Marvis writes much data to the console, for example request headers and request bodies. Do not keep these logs in a shared location.
- The routing call uses a forced tool choice. Some newer Claude models do not accept a forced tool choice. Use a model that accepts it.
- The project uses an old version of `@anthropic-ai/sdk` (0.27).
- Marvis has no tests.

## License

This project uses the MIT license. Refer to the `LICENSE` file.
