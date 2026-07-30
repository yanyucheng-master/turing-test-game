import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../src/index.css";
import CultureReview from "../src/pages/CultureReview";
import { TRPCProvider } from "../src/providers/trpc";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TRPCProvider>
      <CultureReview />
    </TRPCProvider>
  </StrictMode>
);
