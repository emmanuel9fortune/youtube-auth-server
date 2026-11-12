import { httpServerHandler } from "cloudflare:node";

import app from "./server.js";

export default {
  fetch: httpServerHandler({
    port: 3000,
    hostname: "localhost"
  })
};
