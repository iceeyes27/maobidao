import { onRequest as submit } from "./functions/api/submit.js";
import { onRequest as visitorIpCheck } from "./functions/api/visitor-ip-check.js";
import { onRequest as stats } from "./functions/api/stats.js";

export class StatsCounter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/record") {
      const { page, articleId, visitorId, day } = await request.json();

      const result = await this.state.storage.transaction(async (txn) => {
        const sitePvKey = "site:pv";
        const siteUvKey = `site:uv:${day}`;
        const visitorKey = `visitor:${day}:${visitorId}`;

        const [sitePv, siteUv, alreadyVisited] = await Promise.all([
          txn.get(sitePvKey).then((v) => (v ?? 0)),
          txn.get(siteUvKey).then((v) => (v ?? 0)),
          txn.get(visitorKey),
        ]);

        const nextSitePv = sitePv + 1;
        const isNewVisitor = !alreadyVisited;
        const nextSiteUv = isNewVisitor ? siteUv + 1 : siteUv;

        const puts = [
          txn.put(sitePvKey, nextSitePv),
          txn.put(siteUvKey, nextSiteUv),
        ];

        if (isNewVisitor) {
          // TTL 3 days — storage alarm would be cleaner but put+alarm needs separate logic;
          // for KV-backed DO storage there's no native TTL, so we accept minor key accumulation.
          puts.push(txn.put(visitorKey, 1));
        }

        let articlePv = null;
        if (page === "article" && articleId) {
          const articlePvKey = `article:${articleId}:pv`;
          const current = (await txn.get(articlePvKey)) ?? 0;
          articlePv = current + 1;
          puts.push(txn.put(articlePvKey, articlePv));
        }

        await Promise.all(puts);
        return { sitePv: nextSitePv, siteUv: nextSiteUv, articlePv, isNewVisitor };
      });

      return new Response(JSON.stringify(result), {
        headers: { "content-type": "application/json" },
      });
    }

    if (request.method === "GET" && url.pathname === "/snapshot") {
      const page = url.searchParams.get("page");
      const articleId = url.searchParams.get("articleId");
      const day = url.searchParams.get("day");

      const keys = [`site:pv`, `site:uv:${day}`];
      if (page === "article" && articleId) {
        keys.push(`article:${articleId}:pv`);
      }

      const values = await Promise.all(keys.map((k) => this.state.storage.get(k)));
      return new Response(
        JSON.stringify({
          sitePv: values[0] ?? 0,
          siteUv: values[1] ?? 0,
          articlePv: keys.length === 3 ? (values[2] ?? 0) : null,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }

    return new Response("Not found", { status: 404 });
  }
}

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
