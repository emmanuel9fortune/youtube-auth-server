import { httpServerHandler } from "cloudflare:node";

import app from "./app.js";

export default {
  fetch: httpServerHandler({
    port: 3000,
    hostname: "localhost"
  })
};
