import { describe, expect, it } from 'vitest';
import { parseQuerySession } from './gpuTest.js';

const HEAD = ' SESSIONNAME       USERNAME                 ID  STATE   TYPE        DEVICE \r\n services                                    0  Disc                        \r\n';

describe('which Windows session Mediarr runs in', () => {
  it('reads the console session', () => {
    expect(parseQuerySession(`${HEAD}>console           admin                     1  Active                      \r\n`)).toEqual({ name: 'console', id: 1, state: 'Active' });
  });

  it('reads a connected Remote Desktop session', () => {
    expect(parseQuerySession(`${HEAD} console                                     1  Conn\r\n>rdp-tcp#3         admin                     2  Active\r\n`)).toEqual({
      name: 'rdp-tcp#3',
      id: 2,
      state: 'Active',
    });
  });

  it('reads a disconnected session, which has no name', () => {
    expect(parseQuerySession(`${HEAD}>                  admin                     2  Disc\r\n console                                     1  Conn\r\n`)).toEqual({
      name: '',
      id: 2,
      state: 'Disc',
    });
  });

  it('copes with output it doesn’t understand', () => {
    expect(parseQuerySession('')).toBeNull();
    expect(parseQuerySession(`${HEAD} console   admin   1  Active\r\n`)).toBeNull();
  });
});
