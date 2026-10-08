import { describe, expect, it } from "vitest";
import { cubeMesh, makeModel } from "../../test/support/docFixtures";
import { createProject, type DesignColor, type Project } from "@/doc/project";
import { activeAfterDelete, clampActiveState, remapActiveState, stateAfterDelete } from "./activeColor";

const color = (hex: string): DesignColor => ({ color: hex, known: true });
const BASE = color("#808080");

describe("remapActiveState", () => {
  const [a, b, c, d] = ["#AA0000", "#00BB00", "#0000CC", "#DDDD00"].map(color);
  const before = [BASE, a, b, c, d];

  it("follows a color to its new index when an earlier color is deleted", () => {
    const after = [BASE, a, c, d]; // b deleted
    expect(remapActiveState(3, before, after)).toBe(2); // c
    expect(remapActiveState(4, before, after)).toBe(3); // d
    expect(remapActiveState(1, before, after)).toBe(1); // a
  });

  it("goes to the previous color when the active one was deleted, the next one for the first", () => {
    expect(remapActiveState(2, before, [BASE, a, c, d])).toBe(1);
    expect(remapActiveState(1, before, [BASE, b, c, d])).toBe(1); // b is now first
    expect(remapActiveState(4, before, [BASE, a, b, c])).toBe(3);
  });

  it("follows the color back when the deletion is undone, and again on redo", () => {
    const deleted = [BASE, a, c, d];
    expect(remapActiveState(2, deleted, before)).toBe(3); // c was 2, is 3 again
    expect(remapActiveState(1, deleted, before)).toBe(1);
    expect(remapActiveState(2, before, deleted)).toBe(1); // redo with b active -> neighbour
  });

  it("survives several colors changing at once (a batch)", () => {
    const after = [BASE, c, color("#EEEEEE")]; // a, b deleted, d replaced by a new color
    expect(remapActiveState(3, before, after)).toBe(1);
    expect(remapActiveState(1, before, after)).toBe(1); // a gone: nothing earlier, the next survivor is c
    expect(remapActiveState(4, before, after)).toBe(1); // d edited away: nearest earlier survivor is c
  });

  it("never returns a state outside the palette", () => {
    expect(remapActiveState(3, before, [BASE, color("#111111")])).toBe(1);
    expect(remapActiveState(3, before, [BASE])).toBe(1);
  });
});

describe("clampActiveState", () => {
  it("keeps the active state in 1..last", () => {
    expect(clampActiveState(5, 4)).toBe(3);
    expect(clampActiveState(2, 4)).toBe(2);
    expect(clampActiveState(0, 4)).toBe(1);
    expect(clampActiveState(3, 1)).toBe(1);
  });
});

describe("activeAfterDelete", () => {
  it("shifts later colors down", () => {
    expect(stateAfterDelete(5, 2)).toBe(4);
    expect(stateAfterDelete(1, 2)).toBe(1);
    expect(stateAfterDelete(2, 2)).toBe(0);
    expect(activeAfterDelete(5, 2, 1)).toBe(4);
    expect(activeAfterDelete(1, 3, 1)).toBe(1);
  });

  it("moves to the merge target when the active color is the deleted one", () => {
    expect(activeAfterDelete(3, 3, 1)).toBe(1);
    expect(activeAfterDelete(3, 3, 5)).toBe(4);
  });

  it("moves to a neighbour when it is merged into base", () => {
    expect(activeAfterDelete(3, 3, 0)).toBe(2);
    expect(activeAfterDelete(1, 1, 0)).toBe(1);
  });
});

describe("against a real project", () => {
  function fiveColors(): Project {
    const model = makeModel(cubeMesh(), { filaments: ["#FF0000", "#00FF00", "#0000FF", "#FFFF00", "#00FFFF"].map((c) => ({ color: c })), paints: [] });
    const p = createProject(model);
    while (p.palette.length < 6) p.addColor(["#101010", "#202020", "#303030", "#404040"][p.palette.length - 2]);
    return p;
  }

  it("keeps pointing at the same color through delete, undo and redo", () => {
    const p = fiveColors();
    const colors = p.palette.map((c) => c.color);
    let active = 4;
    const track = (fn: () => void) => {
      const before = p.palette;
      fn();
      active = remapActiveState(active, before, p.palette);
    };
    const activeColor = () => p.palette[active].color;
    const was = colors[4];

    track(() => p.deleteColor(2, 1));
    expect(activeColor()).toBe(was);
    track(() => p.deleteColor(1, 2));
    expect(activeColor()).toBe(was);
    track(() => p.undo());
    expect(activeColor()).toBe(was);
    track(() => p.undo());
    expect(activeColor()).toBe(was);
    expect(active).toBe(4);
    track(() => p.redo());
    track(() => p.redo());
    expect(activeColor()).toBe(was);
  });

  it("moves off a deleted active color, and back onto it when the deletion is undone", () => {
    const p = fiveColors();
    let active = 3;
    const was = p.palette[3].color;
    const before = p.palette;
    p.deleteColor(3, 1);
    active = remapActiveState(active, before, p.palette);
    expect(active).toBe(2); // the previous color
    const mid = p.palette;
    p.undo();
    active = remapActiveState(active, mid, p.palette);
    expect(p.palette[active].color).toBe(p.palette[2].color); // stays on the neighbour it moved to
    expect(p.palette[3].color).toBe(was);
  });
});
