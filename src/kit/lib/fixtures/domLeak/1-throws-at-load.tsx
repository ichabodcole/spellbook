// A component test file that throws while it loads: the import has registered
// a DOM and the file never reaches its own hooks. Run only by
// `domGuard.test.ts`, before `2-backend.ts`.

import "../../registerDom.ts";

throw new Error("deliberate throw at module load");
