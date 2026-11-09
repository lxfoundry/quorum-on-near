# Vendored skills: provenance, local modifications, licences

Every skill in this directory is **vendored, not authored here**. They are general-purpose public
libraries: they hold no project-specific design, code or assets, and they are committed so the AI
workflow is reproducible and disclosed. Repo-specific guidance belongs in `CLAUDE.md`, never in
these files.

## Sources

21 skills come from three upstream repositories.

| Skills | Source | Licence |
|---|---|---|
| `writing-plans`, `brainstorming`, `subagent-driven-development`, `executing-plans`, `requesting-code-review`, `receiving-code-review`, `finishing-a-development-branch`, `test-driven-development`, `systematic-debugging`, `dispatching-parallel-agents`, `verification-before-completion`, `writing-skills`, `using-superpowers` | [obra/superpowers](https://github.com/obra/superpowers) @ `b36e0829c6d0140e93cfef2ca599b1b07d4a7797` (2026-08-12) | MIT, © 2025 Jesse Vincent (text below) |
| `when-stuck`, `inversion-exercise`, `meta-pattern-recognition`, `collision-zone-thinking`, `scale-game`, `simplification-cascades`, `root-cause-tracing` | [obra/superpowers-skills](https://github.com/obra/superpowers-skills) @ `cdcd624ad3fd8026deb692e565351854569798dd` (2025-10-14) | MIT, © 2025 Jesse Vincent (same text) |
| `feature-planning` | [mhattingpete/claude-skills-marketplace](https://github.com/mhattingpete/claude-skills-marketplace), `engineering-workflow-plugin/skills/feature-planning` @ `b5b34bcf4c920bb72cee1c391b54a33cb5353c12` (2026-07-25) | Apache-2.0 (text below) |

Where a skill existed in both `obra` repos, the newer `obra/superpowers` copy was taken.
`root-cause-tracing` exists only in `superpowers-skills`, so it comes from there. Note that
`systematic-debugging` also bundles its own `root-cause-tracing.md` supporting doc, so that
material appears twice.

Skills added later for a specific ecosystem (a chain's official skill, for example) are listed
under [Ecosystem skills](#ecosystem-skills) at the end of this file.

### Problem-solving lineage

The six problem-solving skills (`when-stuck`, `inversion-exercise`, `meta-pattern-recognition`,
`collision-zone-thinking`, `scale-game`, `simplification-cascades`) were derived upstream from
agent patterns in the [Amplifier](https://github.com/microsoft/amplifier) project (commit
`2adb63f858e7d760e188197c8e8d4c1ef721e2a6`, 2025-10-10):

- **From the `insight-synthesizer` agent:** `simplification-cascades`, `collision-zone-thinking`,
  `meta-pattern-recognition`, `inversion-exercise`, `scale-game`
- **Dispatch pattern:** `when-stuck` maps stuck-symptoms to the right technique

## Local modifications

The skills are vendored as plain project skills rather than as a plugin, which required the edits
below to the two `obra` sets. Upstream content is otherwise unchanged. `feature-planning` is
byte-identical to upstream; its unreferenced `references/planning-best-practices.md` was not
vendored.

1. **Frontmatter `name:` normalised to the directory name.** The `superpowers-skills` originals
   use title case with spaces (`Collision-Zone Thinking`, `Root Cause Tracing`, `When Stuck -
   Problem-Solving Dispatch`); Claude Code requires kebab-case matching the skill directory, so
   they would otherwise fail to load.
2. **`when_to_use:` folded into `description:`.** `description` is the field Claude Code reads
   for skill discovery, so the trigger text was appended to it rather than left in a field that
   is never consulted.
3. **`superpowers:<skill-name>` cross-references rewritten to bare names.** The plugin namespace
   does not resolve in a project install.
4. **`when-stuck` dispatch targets rewritten** from repo paths
   (`skills/problem-solving/scale-game`) to bare skill names.

### No worktrees (project decision)

These repositories do not use git worktrees. Skills that instructed the agent to create one now
say to create a dedicated branch instead:

- `executing-plans` (Step 1), `subagent-driven-development` (Setup), `writing-plans` (Context
  note): worktree creation → dedicated branch
- `requesting-code-review/code-reviewer.md`: inspecting another revision now suggests
  `git archive` into a temp dir rather than `git worktree add`
- `using-git-worktrees` was **deliberately not installed**

`finishing-a-development-branch` retains its worktree *cleanup* logic. It self-detects
(`GIT_DIR == GIT_COMMON` → "normal repo, no worktree to clean up"), so here that path is inert.

Remaining `worktree` matches elsewhere are incidental: `WorktreeManager` is a class name in
unrelated example bug scenarios in `root-cause-tracing` / `systematic-debugging`, and
`using-superpowers/references/codex-tools.md` is a Codex-CLI-only reference file that Claude Code
never reads.

### Not installed

From the same upstream groups: `using-git-worktrees` (see above), `preserving-productive-tensions`
(architecture), `tracing-knowledge-lineages` (research), `defense-in-depth`,
`remembering-conversations`.

## Notes

- `using-superpowers` is designed to be force-loaded at conversation start by the upstream
  plugin's SessionStart hook. Since these are plain project skills with no plugin, that hook is
  reproduced locally: `.claude/hooks/session-start-superpowers.py`, wired up in
  `.claude/settings.json`. It reads the skill and emits it as `additionalContext` at every session
  start, and exits silently if the skill is ever removed. It needs `python` on PATH; without it the
  session still starts, with a hook error and without the skill injected. The skill's "Platform
  Adaptation" section lists Codex/Pi/Antigravity/Hermes reference files: none apply to Claude Code.
- `brainstorming`'s optional visual companion writes to `.superpowers/brainstorm/`, and
  `subagent-driven-development` to `.superpowers/sdd/`. `.superpowers/` is gitignored.
- `writing-plans` defaults to saving plans at `docs/superpowers/plans/`, and `brainstorming` specs
  at `docs/superpowers/specs/`. These upstream defaults are left unchanged in the skill files; the
  repo's `CLAUDE.md` overrides where plans and specs go.
- Eight files are scripts and are committed executable (`100755`): `brainstorming/scripts/start-server.sh`,
  `brainstorming/scripts/stop-server.sh`, `root-cause-tracing/find-polluter.sh`,
  `subagent-driven-development/scripts/{review-package,sdd-workspace,task-brief}`,
  `systematic-debugging/find-polluter.sh`, `writing-skills/render-graphs.js`.

## Licences

### MIT: obra/superpowers and obra/superpowers-skills

```
MIT License

Copyright (c) 2025 Jesse Vincent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Apache License 2.0: mhattingpete/claude-skills-marketplace (`feature-planning`)

```
Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1. Definitions.

"License" shall mean the terms and conditions for use, reproduction, and distribution as defined by Sections 1 through 9 of this document.

"Licensor" shall mean the copyright owner or entity authorized by the copyright owner that is granting the License.

"Legal Entity" shall mean the union of the acting entity and all other entities that control, are controlled by, or are under common control with that entity. For the purposes of this definition, "control" means (i) the power, direct or indirect, to cause the direction or management of such entity, whether by contract or otherwise, or (ii) ownership of fifty percent (50%) or more of the outstanding shares, or (iii) beneficial ownership of such entity.

"You" (or "Your") shall mean an individual or Legal Entity exercising permissions granted by this License.

"Source" form shall mean the preferred form for making modifications, including but not limited to software source code, documentation source, and configuration files.

"Object" form shall mean any form resulting from mechanical transformation or translation of a Source form, including but not limited to compiled object code, generated documentation, and conversions to other media types.

"Work" shall mean the work of authorship, whether in Source or Object form, made available under the License, as indicated by a copyright notice that is included in or attached to the work.

"Derivative Works" shall mean any work, whether in Source or Object form, that is based on (or derived from) the Work and for which the editorial revisions, annotations, elaborations, or other modifications represent, as a whole, an original work of authorship. For the purposes of this License, Derivative Works shall not include works that remain separable from, or merely link (or bind by name) to the interfaces of, the Work and Derivative Works thereof.

"Contribution" shall mean any work of authorship, including the original version of the Work and any modifications or additions to that Work or Derivative Works thereof, that is intentionally submitted to Licensor for inclusion in the Work by the copyright owner or by an individual or Legal Entity authorized to submit on behalf of the copyright owner. For the purposes of this definition, "submitted" means any form of electronic, verbal, or written communication sent to the Licensor or its representatives, including but not limited to communication on electronic mailing lists, source code control systems, and issue tracking systems that are managed by, or on behalf of, the Licensor for the purpose of discussing and improving the Work, but excluding communication that is conspicuously marked or otherwise designated in writing by the copyright owner as "Not a Contribution."

"Contributor" shall mean Licensor and any individual or Legal Entity on behalf of whom a Contribution has been received by Licensor and subsequently incorporated within the Work.

2. Grant of Copyright License. Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright license to reproduce, prepare Derivative Works of, publicly display, publicly perform, sublicense, and distribute the Work and such Derivative Works in Source or Object form.

3. Grant of Patent License. Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable (except as stated in this section) patent license to make, have made, use, offer to sell, sell, import, and otherwise transfer the Work, where such license applies only to those patent claims licensable by such Contributor that are necessarily infringed by their Contribution(s) alone or by combination of their Contribution(s) with the Work to which such Contribution(s) was submitted. If You institute patent litigation against any entity (including a cross-claim or countermlaim in a lawsuit) alleging that the Work or a Contribution incorporated within the Work constitutes direct or contributory patent infringement, then any patent licenses granted to You under this License for that Work shall terminate as of the date such litigation is filed.

4. Redistribution. You may reproduce and distribute copies of the Work or Derivative Works thereof in any medium, with or without modifications, and in Source or Object form, provided that You meet the following conditions:

(a) You must give any other recipients of the Work or Derivative Works a copy of this License; and

(b) You must cause any modified files to carry prominent notices stating that You changed the files; and

(c) You must retain, in the Source form of any Derivative Works that You distribute, all copyright, patent, trademark, and attribution notices from the Source form of the Work, excluding those notices that do not pertain to any part of the Derivative Works; and

(d) If the Work includes a "NOTICE" text file as part of its distribution, then any Derivative Works that You distribute must include a readable copy of the attribution notices contained within such NOTICE file, excluding those notices that do not pertain to any part of the Derivative Works, in at least one of the following places: within a NOTICE text file distributed as part of the Derivative Works; within the Source form or documentation, if provided along with the Derivative Works; or, within a display generated by the Derivative Works, if and wherever such third-party notices normally appear. The contents of the NOTICE file are for informational purposes only and do not modify the License. You may add Your own attribution notices within Derivative Works that You distribute, alongside or as an addendum to the NOTICE text from the Work, provided that such additional attribution notices cannot be construed as modifying the License.

You may add Your own copyright statement to Your modifications and may provide additional or different license terms and conditions for use, reproduction, or distribution of Your modifications, or for any such Derivative Works as a whole, provided Your use, reproduction, and distribution of the Work otherwise complies with the conditions stated in this License.

5. Submission of Contributions. Unless You explicitly state otherwise, any Contribution intentionally submitted for inclusion in the Work by You to the Licensor shall be under the terms and conditions of this License, without any additional terms or conditions. Notwithstanding the above, nothing herein shall supersede or modify the terms of any separate license agreement you may have executed with Licensor regarding such Contributions.

6. Trademarks. This License does not grant permission to use the trade names, trademarks, service marks, or product names of the Licensor, except as required for reasonable and customary use in describing the origin of the Work and reproducing the content of the NOTICE file.

7. Disclaimer of Warranty. Unless required by applicable law or agreed to in writing, Licensor provides the Work (and each Contributor provides its Contributions) on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied, including, without limitation, any warranties or conditions of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A PARTICULAR PURPOSE. You are solely responsible for determining the appropriateness of using or redistributing the Work and assume any risks associated with Your exercise of permissions under this License.

8. Limitation of Liability. In no event and under no legal theory, whether in tort (including negligence), contract, or otherwise, unless required by applicable law (such as deliberate and grossly negligent acts) or agreed to in writing, shall any Contributor be liable to You for damages, including any direct, indirect, special, incidental, or consequential damages of any character arising as a result of this License or out of the use or inability to use the Work (including but not limited to damages for loss of goodwill, work stoppage, computer failure or malfunction, or any and all other commercial damages or losses), even if such Contributor has been advised of the possibility of such damages.

9. Accepting Warranty or Additional Liability. While redistributing the Work or Derivative Works thereof, You may choose to offer, and charge a fee for, acceptance of support, warranty, indemnity, or other liability obligations and/or rights consistent with this License. However, in accepting such obligations, You may act only on Your own behalf and on Your sole responsibility, not on behalf of any other Contributor, and only if You agree to indemnify, defend, and hold each Contributor harmless for any liability incurred by, or claims asserted against, such Contributor by reason of your accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS

Copyright 2025 mhattingpete

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## Ecosystem skills

### NEAR Agent Skills: deliberately not vendored

| | |
|---|---|
| Source | <https://github.com/near/agent-skills>: eight skills (`near-ai-cloud`, `near-api-js`, `near-cli-rs`, `near-contract-audit`, `near-dapp`, `near-intents`, `near-kit`, `near-smart-contracts`) |
| Reviewed at | `cb32b6af195e636c1e9c2efe2ea75a6d85b6b67b` (head of `main`, 2026-09-28; the repo has no tags or releases) |
| Licence | **None.** No licence file, and GitHub detects none. Only `near-smart-contracts/SKILL.md` declares `license: MIT` in its frontmatter, with no copyright notice |
| Decision | Not committed to this repository while that is so. `.gitignore` excludes `.claude/skills/near-*/`, so a local install cannot be committed by mistake. Check the upstream root for a `LICENSE` before changing this |
