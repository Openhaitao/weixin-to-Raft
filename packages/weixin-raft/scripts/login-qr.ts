/**
 * Headless WeChat binding for remote operators: prints the QR payload URL on
 * a parseable line (`QR_URL <url>`) so the operator can render it as an image
 * and hand it to the user on another surface (chat channel, web page), then
 * waits for the scan to complete. The terminal QR is suppressed.
 */

import { isLoggedIn, login } from "weixin-agent-sdk";

if (isLoggedIn()) {
  console.log("ALREADY_LOGGED_IN");
  process.exit(0);
}

const accountId = await login({
  printQr: false,
  onQr: (start) => {
    console.log(`QR_URL ${start.qrcodeUrl}`);
  },
});
console.log(`LOGIN_OK ${accountId}`);
