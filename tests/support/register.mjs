// Loaded with `node --import` before the unit tests. See hooks.mjs.
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
