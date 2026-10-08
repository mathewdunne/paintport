// All user-facing text lives here so i18n can be added later (English only for now).
export const strings = {
  appName: "PaintPort+",
  header: {
    import: "Import",
    importHint: "Import a 3MF, STL or OBJ file",
    classic: "Classic",
    classicHint: "Open the original single-file PaintPort",
  },
  theme: {
    label: "Theme",
    light: "Light",
    dark: "Dark",
    system: "System",
  },
  tools: {
    label: "Tools",
    brush: "Brush",
    shellFill: "Shell fill",
    smartFill: "Smart fill",
    eraser: "Eraser",
    eyedropper: "Eyedropper",
  },
  viewport: {
    emptyTitle: "Drop a 3MF, STL or OBJ",
    emptyHint: "or use Import to pick a file",
    viewMode: "Viewport colors",
    design: "Design",
    print: "Print",
  },
  panel: {
    paint: "Paint",
    objects: "Objects",
    export: "Export",
    palette: "Design palette",
    paletteEmpty: "Colors you paint with will appear here.",
    brushSize: "Brush size",
    smartFillAngle: "Smart fill angle",
    objectsEmpty: "No objects loaded.",
    exportEmpty: "Export settings appear here once a model is loaded.",
  },
} as const;
