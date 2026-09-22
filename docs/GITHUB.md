# GitHub text for VS Studio 5000 0.3.0

Two parts: the release description (paste into the GitHub release for tag `v0.3.0`, or use it as the repository's first README summary), and a one-line commit message for each file in `src/`.

---

## Release description: VS Studio 5000 0.3.0

VS Studio 5000 opens Rockwell Studio 5000 Logix Designer projects in VS Code. Open a folder that
contains `.ACD` or `.L5X` files, and each project is decoded into plain-text files that you, and an AI
assistant, can read, search and edit. The project file is never changed. Edits are packaged as
`.L5X` files that you import into Studio 5000 yourself.

### What it does

**Reads the whole project, from the `.ACD` you have on site or from an `.L5X`.**
- Tasks and their schedule; programs with main and fault routines.
- Ladder rungs with their comments, as Logix neutral text.
- Structured Text, including the ST inside Add-On Instructions, as the original source with comments and indentation.
- AOIs: parameters in definition order, with usage, required flag, data type and array size; local tags; revision.
- Tags with array sizes and constant, external access and produced/consumed flags.
- User-defined types, including `BIT` members with their host and bit number; the predefined types the project uses.
- The I/O module tree: slot or IP address, revision, description, inhibited, catalog number; the processor type.
- FBD and SFC routines from an `.L5X`, as a read-only text view.

**Knows what is safety, from the project, not from names.**
- The safety task and its programs, safety-class AOIs and tags, safety I/O modules and the safety tag map are all decoded, from `.ACD` and `.L5X` alike.
- `CODEBASE.md` lists them. If a project lacks any of them, a note says so.
- Name-based rules exist for sites whose naming is reliable. They are off unless you turn them on for a project.

**Lets you find anything.**
- An Explorer view laid out like the Controller Organizer.
- Hover on a tag for its type, description, safety flag and where it is used.
- Find Tag Usage jumps to every rung and ST line that writes or reads a tag.
- The cross reference understands AOIs: an argument passed to an InOut parameter is recorded at the members the AOI's own logic writes, whether that logic is ladder or Structured Text.
- A command-line lookup gives any tool a tag's (or a single member's) writers and readers with their logic.

**Checks the logic on every export.**
- `SAFETY.md` follows each safety device from where it is mapped to which of its outputs are used, whether they reach an output, and whether they are read through a bypassed contact.
- `BYPASSES.md` lists shorted or disabled contacts.
- `UNCONSUMED.md` lists signals written but never read.

**Keeps the noise out.**
- AOI records left behind by deletes, and predefined or module types nothing uses, are kept out of the lists and counts.
- They are listed in `UNUSED.md` in case they are needed.
- Module connection tags (`X:I`, `X:O`, `X:C`) are listed separately from user tags.
- **Clean Up Exports** removes export folders no longer needed, after showing their project file and any unpackaged edits.

**Works with AI assistants.**
- Each workspace gets a guide file for Claude Code, Cline, Cursor or GitHub Copilot. It explains where everything is, how the routine files work and which safety rules to respect.
- Claude Code is kept away from the binary `.ACD`.

**Packages your edits.**
- Edit a ladder or ST routine file, then run **Build L5X Import from Edits**.
- Each routine is checked for structure, unknown instructions, undefined tags and missing JSR targets.
- Only real changes count as edits (logic, comments, ST source), never layout or a plugin update, and an export folder is locked while written so two windows can't corrupt it.
- The result is a Studio 5000 routine import plus a report.

**Shows what it did.**
- An activity log records every export (why it ran and how long it took), every file written, every edit detected, packaged or discarded, and every file change acted on or ignored.
- **Show Activity Log** opens it, with a per-window log file you can attach to a bug report.

### Supported input

| | `.ACD` | `.L5X` |
|---|---|---|
| Ladder, rung comments, tasks, programs | yes | yes |
| Structured Text (programs and AOIs) | yes | yes |
| FBD / SFC | listed | read-only text view |
| AOIs, tags and tag flags, UDTs, I/O tree | yes | yes |
| Safety task, programs, AOIs, tags, I/O, tag map | yes | yes |
| Aliases | — | yes |

The `.ACD` format is undocumented. The decoder was checked against Studio 5000's own L5X export of
the same project, and they match: every program and routine; rung text byte for byte and every rung
comment; Structured Text line for line; tags with their safety class, constant, access, produced and
consumed flags; AOI parameters (order, usage, types, array sizes); UDT members including bit members;
tasks; the module tree; and the safety tag map. Anything the decoder cannot interpret is listed in
`CODEBASE.md`, never silently dropped.

### Install

1. Download `vs-studio5000-0.3.0.vsix` from this release.
2. In VS Code: **Extensions** → `…` → **Install from VSIX…**, or run
   `code --install-extension vs-studio5000-0.3.0.vsix`.
3. Open a folder that contains `.ACD` or `.L5X` files. The **Studio 5000** view appears in the Explorer.

Requires VS Code 1.74 or later. Studio 5000 is only needed to import the packaged edits.

### Known limits

- FBD and SFC logic in an `.ACD` is listed but not decoded; export those programs to `.L5X` to read them.
- Tag values (initial data) are not exported. Alias targets are not read from an `.ACD`.
- An `.ACD` does not store every module's catalog number. Known products get it from their product code; any other shows its device type and product code instead.
- The `.ACD` decoder was checked on V31 projects. Other versions are expected to work; anything unrecognised is reported in `CODEBASE.md`.
- Safety checks support a review and do not replace safety validation.

---

## Commit messages for `src/`

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

