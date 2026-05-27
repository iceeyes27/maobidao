import { onRequest as submit } from "./functions/api/submit.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/submit") {
      return submit({ request, env });
    }

    return env.ASSETS.fetch(request);
  },
};
