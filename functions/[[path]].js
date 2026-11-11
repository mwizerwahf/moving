// Every request not served from /public (see public/_routes.json) arrives here.
import { handle } from "../src/app.js";

export const onRequest = handle;
