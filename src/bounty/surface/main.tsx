import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// The favicon lives with the board's other assets, served by the daemon at
// /assets/. index.html ships an empty placeholder because the bundler resolves
// <link href> off disk and this file is not a build input; point it at the
// served path now that we are running against the daemon.
const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
if (icon) icon.href = "/assets/favicon.png";

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);
