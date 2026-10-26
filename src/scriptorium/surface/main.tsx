import { createRoot } from "react-dom/client";
import { useDaemon } from "../../kit/context/useDaemon";
import { Frame } from "./Frame";

/** The page's one connection: `/ws` on the daemon that served it. */
function FramePage() {
  return <Frame daemon={useDaemon()} />;
}

const el = document.getElementById("root");
if (el) createRoot(el).render(<FramePage />);
