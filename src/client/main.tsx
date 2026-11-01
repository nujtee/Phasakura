import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { captureCampaign } from "./analytics/campaign.ts";
import { RouterProvider } from "./router/Router.tsx";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/accommodation.css";
import "./styles/booking.css";
import "./styles/bill.css";
import "./styles/content.css";
import "./styles/search.css";
import "./styles/consent.css";

// Where this visit came from (migration 0052), before the router rewrites the URL.
captureCampaign();

const container = document.getElementById("root");
if (!container) throw new Error("#root element not found");

createRoot(container).render(
  <StrictMode>
    <RouterProvider>
      <App />
    </RouterProvider>
  </StrictMode>,
);
