import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev-only proxy: the backend (Django, running on port 8001) is a
// separate process. Proxying /api means the frontend can call relative
// paths like `/api/auth/login/` exactly as the auth docs show, with no CORS
// setup needed in dev. Change the target if the backend runs elsewhere.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8001",
        changeOrigin: true,
      },
    },
  },
});
