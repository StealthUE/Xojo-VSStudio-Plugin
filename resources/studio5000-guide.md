<!-- vs-studio5000-guide v2 -->
# Studio 5000 projects in this workspace

This folder contains Rockwell Studio 5000 Logix Designer projects. The **VS Studio 5000**
extension decodes each one into a readable export folder. Work from the export.

## Projects

{{PROJECT_TABLE}}

`ok` is current. `stale` means the project file changed and is being re-exported, so wait and
re-read. `missing` or `broken` means ask the user to run **Studio 5000: Re-export Project**.

## Rules

- **Never open, read, search or edit a `.ACD` file.** It is a compressed binary database and
  the text you would see is meaningless. Read `CODEBASE.md` in its export folder instead.
- `.L5X` files are XML and can be large. Prefer the export there too.
- The export is the only thing you edit. The extension never writes the `.ACD`. Edited
  routines are packaged as `.L5X` files that the user imports into Studio 5000 themselves.

## Where to look (inside an export folder)

| Question | File |
|---|---|
| What is in the project? Programs, routines, AOIs, tasks, anything not decoded | `CODEBASE.md` |
| What runs, in what order? Task → program → main routine → JSR tree | `PROJECT_MAP.md` |
| Where is tag X written / read? | the `xref` command below, or `xref/<scope>.md` (index: `CROSSREF.md`) |
| Safety devices (E-stops, gates, light curtains…): mapped? consumed? bypassed? reach an output? | `SAFETY.md` |
| Shorted or disabled contacts (empty/NOP legs, AFI, XIC+XIO) | `BYPASSES.md` |
| Signals written but never read ("mapped but not consumed") | `UNCONSUMED.md` |
| Tag type, dimensions, flags (safety, produced, consumed), description, usage count | `TAGS.md`, `Controller/Tags.csv`, `Programs/<P>/Tags.csv` |
| UDT members | `DATATYPES.md` |
| AOI parameters, call signature and logic | `AOIS.md`, `AOIs/<AOI>/*.rll` / `*.st` |
| Hardware: modules, slots, IP addresses, safety I/O | `MODULES.md` |
| What is safety in this project (safety task, programs, AOIs, tags, tag map) | `CODEBASE.md` → *Safety information* |
| Definitions nothing uses (stale AOI records, unused predefined types) | `UNUSED.md` |
| The logic itself | `Programs/<Program>/<Routine>.rll` (ladder) / `.st` (Structured Text) |

Locations are written `Program/Routine#12` for rung 12 and `Program/Routine#L40` for line 40 of an
ST routine (1-based, as Studio 5000 numbers ST lines). AOI routines are `AOI <Name>/<Routine>`.

### One tag, fast

```
node "{{CLI}}" xref "<export folder>" <Tag or Tag.Member> [--program <Program>]
node "{{CLI}}" rung "<export folder>" <Program>/<Routine> <rung number | L<line>>
```

`xref` prints every rung and ST line that writes and reads the tag, with its text. AOI calls are
resolved through the AOI definition (ladder or ST logic), so an InOut argument shows up at the
members the AOI really writes, e.g. `Zone1_EStop.Ok` written by `EStop_Device.Device`. In ST,
`:=` marks an assignment. Searching the routine files for a tag name also works, because logic
always uses full tag names (tag names are case-insensitive in Logix).

## Routine file format

### Ladder (.rll)

```
// @program MainProgram          <- metadata: leave these lines as they are
// @routine _030_Mode
// @type RLL
// @description What the routine does

// ---- Rung 0 ----              <- marker, regenerated; numbers are not significant
// > Comment for the rung below  <- "// >" lines are the rung comment (one or more lines)
XIC(Start_PB)[OTE(Motor_Run) ,OTE(Lamp) ];
```

- Logix **neutral text**, ending with `;`. This is exactly what Studio 5000 shows in the rung text
  editor and stores in L5X `<Text>`. Short rungs are on one line. Long rungs with branches are laid
  out one branch leg per line (`[` opens, `,` starts the next leg, `]` closes, nested legs indented).
  Line breaks and spaces between instructions do not matter.
- Instructions: `XIC(tag)`, `XIO(tag)`, `OTE/OTL/OTU(tag)`, `TON(timer,?,?)`, `MOV(src,dest)`,
  `JSR(Routine,0)`, and so on, with operands separated by commas.
- A branch is `[leg1 ,leg2 ,leg3 ]`. Branches nest.
- `?` is a placeholder operand, for example the preset/accum display of `TON(T,?,?)`.
- Tags: `Tag`, `Tag.Member`, `Tag[3].Bit`, `Tag.5` (bit of an integer), module I/O `Local:1:I.Data.0`.
  Program-scoped tags hide controller tags of the same name inside that program.
- To add a rung, insert a new line (and optional `// >` comment lines) where it should go. To delete
  a rung, remove its line. Rung numbers are recomputed when the edits are packaged.

### Structured Text (.st)

The same `// @` header, one blank line, then the routine's source exactly as written in Studio 5000,
comments and indentation included. Line 1 of the source is the first line after the blank line.
Edit it as normal ST: `:=` assignment, `IF … THEN … ELSIF … ELSE … END_IF;`, `CASE … OF … END_CASE;`,
`FOR i := 0 TO n DO … END_FOR;`, `WHILE`/`REPEAT`, AOI and instruction calls such as
`MyAoi(Instance, Arg1, Arg2);` and `JSR(Routine);`.

FBD and SFC routines (from an L5X) are exported as a **read-only** text view in ST syntax: each
FBD wire as `Block.Pin := Source;`, each SFC step with its actions, each transition as
`Transition := condition;`. Read them; do not edit them (they are not packaged).

## Making changes

1. Edit the `.rll` / `.st` files in the export folder. Keep the `// @` header lines.
2. Check tags exist (`TAGS.md`) and the instruction syntax matches existing logic. New tags must be
   created by the user in Studio 5000, so list any you introduce.
3. Ask the user to run **Studio 5000: Build L5X Import from Edits**. It validates each edited routine
   (ladder: rung structure, instructions; ST: brackets, comments, IF/CASE/FOR/WHILE/REPEAT blocks;
   both: tags and JSR targets) and writes `edits/<Program>__<Routine>.L5X` plus `edits/IMPORT_REPORT.md`.
4. Re-exporting keeps edited files, so they are not lost if the project reloads.
   **Studio 5000: Discard Edits** restores them.

AOI logic cannot be packaged as a routine (the AOI definition is edited in Studio 5000), and
FBD/SFC views and source-protected routines cannot be packaged. The report says so.

## Safety

This is industrial control code that moves real machinery. Before proposing changes, trace the
tag's writers with `xref` (a tag written in two places is a common fault). When reviewing safety,
start from `SAFETY.md` and `BYPASSES.md`, which are generated from the logic on every export.
Keep safety logic unchanged unless the user explicitly asks: the safety task and the programs it
runs, safety-class AOIs and safety tags (all marked in `CODEBASE.md`, `AOIS.md` and `TAGS.md`).
Safety is what the project file records, not what a name suggests: a tag called `SAFE_…` can be a
standard tag, and a standard AOI can have "Safety" in its name.
Call out anything that changes outputs, interlocks, E-stop or guarding behaviour.
