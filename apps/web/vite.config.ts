import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: "apps/web",
  plugins: [
    react(),
    {
      name: "qr-routes",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const path = (req.url ?? "/").split("?")[0];
          if (!/^\/q[a-zA-Z0-9_]*/.test(path)) return next();
          console.log(
            JSON.stringify({ event: "qr_page_turn", path, method: req.method }),
          );
          res.writeHead(302, { location: "/", "cache-control": "no-store" });
          res.end();
        });
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/config.json": "http://127.0.0.1:3001",
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
