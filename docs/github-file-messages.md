# Commit messages for `src/`

One line per file, for the commit that adds it (shown next to the file in the GitHub file list).

| File | Commit message |
|---|---|
| `src/acd/aoiOrder.ts` | Infer AOI parameter order from call sites and argument types when no stored order exists |
| `src/acd/comps.ts` | Read Comps.Dat, the ACD object database: objects, attributes and the rung Region Map |
| `src/acd/container.ts` | Open the ACD container: directory trailer, embedded files and gzip streams |
| `src/acd/datDb.ts` | Generic reader for the record databases embedded in an ACD |
| `src/acd/decoder.ts` | Decode an ACD: tasks, programs, rungs, ST, AOIs, tags with safety and access flags, in Studio order |
| `src/acd/infoXml.ts` | Parse QuickInfo.XML and TagInfo.XML: identity, tags, data types and BIT members with their host |
| `src/acd/logic.ts` | Decode rung neutral text, rung comments and references to named objects |
| `src/acd/modules.ts` | Decode the I/O tree: parents, addresses, catalog numbers, inhibit, safety I/O, processor type |
| `src/acd/stSource.ts` | Decode ST source, AOI parameter order and the safety tag map from Nameless.Dat |
| `src/aiFiles.ts` | Write AI guide files for each workspace, and deny rules that keep AI off the binary ACD |
| `src/cli.ts` | Command-line cross reference for a tag or single member, and rung/ST line lookup; safe to pipe |
| `src/customEditor.ts` | Read-only project summary page with shortcuts to the export, re-export and activity log |
| `src/export/analysis.ts` | Safety, bypass and unconsumed-signal checks; safety from the project file, name rules opt-in |
| `src/export/aoiIndex.ts` | Build AOI call signatures so arguments bind to Input, Output and InOut parameters |
| `src/export/edits.ts` | Package edited ladder and ST routines as L5X imports, with an import report |
| `src/export/exporter.ts` | Write the export folder under a lock: routine files, docs, cross reference, edit tracking, stale-file cleanup |
| `src/export/logicUnits.ts` | Treat ladder rungs and ST lines as one kind of addressable logic unit |
| `src/export/routineFile.ts` | Editable text format for routines (.rll and .st), and its parser |
| `src/export/rungText.ts` | Parse ladder neutral text: instructions, branches, layout and read/write operands |
| `src/export/stText.ts` | Analyse Structured Text: reads, writes, AOI calls, JSR targets and structure checks |
| `src/export/unused.ts` | Set aside AOI records and data types nothing uses, keeping them for UNUSED.md |
| `src/extension.ts` | VS Code extension entry: discover, export and watch projects; commands; activity log; export cleanup |
| `src/hover.ts` | Hover on a tag for its type, description, safety flag and where it is written and read |
| `src/l5x/graphical.ts` | Render FBD and SFC routines from an L5X as a read-only ST-syntax text view |
| `src/l5x/parse.ts` | Parse an L5X into the controller model: safety classes, tag map, modules, protected AOIs |
| `src/l5x/write.ts` | Validate edited routines and write them as Studio 5000 L5X routine exports |
| `src/log.ts` | Timestamped activity log: output channel plus a rolling per-window log file |
| `src/model.ts` | Format-neutral model of a Logix 5000 controller project |
| `src/project.ts` | Load an ACD or L5X and export it, independent of VS Code |
| `src/tree.ts` | Explorer view laid out like the Studio 5000 Controller Organizer |
