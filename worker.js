import { onRequest as submit } from "./functions/api/submit.js";
import { onRequest as visitorIpCheck } from "./functions/api/visitor-ip-check.js";
import { onRequest as stats } from "./functions/api/stats.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/submit") {
      return submit({ request, env });
    }

    if (url.pathname === "/api/visitor-ip-check") {
      return visitorIpCheck({ request, env });
    }

    if (url.pathname === "/api/stats") {
      return stats({ request, env });
    }

    return env.ASSETS.fetch(request);
  },
};
