import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isReservedHandle } from '../src/handler.js';

// A handle is the first part of the app's skin folder name (<handle>.<slug>);
// on Windows "con.anything" opens the console device instead of a folder.
test('Windows device names are reserved handles', () => {
  for (const h of ['con', 'prn', 'aux', 'nul', 'com0', 'com1', 'com9', 'lpt1', 'lpt9']) assert.equal(isReservedHandle(h), true, h);
  for (const h of ['console', 'com10', 'auxiliary', 'null', 'nulls']) assert.equal(isReservedHandle(h), false, h);
});
