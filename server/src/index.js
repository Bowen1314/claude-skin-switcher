// Worker entry: wires the real D1 binding, fetch and clock into the handler.
import { handle } from './handler.js';

export default {
  fetch(request, env) {
    return handle(request, env);
  },
};
