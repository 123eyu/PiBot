# image-quality-prompt

Prompt text used by `image-quality-prompt.ts`. Each `## \`key\`` block is sent to the model exactly as written (blank lines around a block are ignored); `{{name}}` is filled in by the code. After editing, run `pnpm gen:prompts`. Changing a block changes the cached prompt prefix (see docs/prompt-cache.md).

## `QUALITY.zh`

图像质量指导：用户请求中的主体、数量、构图、风格、尺寸、透明背景和文字要求优先。先选贴合用途的美术方向和场景气氛，用主次、留白、受控配色与统一线条/材质组织画面，先建立有辨识度的主体轮廓和姿态，再用表情、光影和局部纹理丰富画面，不靠无关装饰堆砌。落实整体构图与局部细节：主体轮廓可辨，比例和透视连贯，生物肢体/机械部件数量与连接合理，支撑和接触可信，前后遮挡明确；光源、阴影、材质和边缘符合所选风格。避免无意的畸形、重复/缺失部件、粘连、悬浮、错误裁切和背景干扰。需要文字时核拼写、字形与可读性。只补完成画面必要的细节；不擅加标题、水印、品牌、边框、无关主体或拼贴。编辑时保留未要求修改的内容和既有透明性。这些是生成要求，不代表输出已经过独立视觉检查。

## `QUALITY.en`

Image quality guidance: prioritize the user's subject, count, composition, style, dimensions, transparency and requested text. Choose a purposeful art direction and scene mood. Organize hierarchy, whitespace, a controlled palette and consistent line/material treatment. Establish recognizable silhouettes and poses before enriching expression, lighting and texture, without piling on unrelated decoration. Resolve the whole composition and local detail: recognizable silhouettes, coherent proportions/perspective, plausible anatomy and mechanical part counts/connections, credible support/contact and clear occlusion; keep light, shadows, materials and edges consistent with the chosen style. Avoid unintended distortions, duplicate/missing parts, fused or floating elements, accidental cropping and distracting backgrounds. Check requested text for spelling, letter forms and legibility. Add only details needed to complete the image; no unsolicited titles, watermarks, branding, frames, unrelated subjects or collage. In edits, preserve unchanged content and existing transparency. These are generation requirements, not evidence of independent visual inspection.

## `BRIEF.zh.item1`

出图规格（按用户请求逐项落实；请求没写的项选贴合用途的做法，不自行加品牌色、标志或画面文字）：

## `BRIEF.zh.item2`

- 用途与比例：按请求的用途和比例构图；没写比例时按用途选常用比例（封面 16:9、帖子 3:4 或 1:1、竖屏 9:16、图标 1:1、海报 2:3）。

## `BRIEF.zh.item3`

- 主体：是什么、什么状态、什么动作。

## `BRIEF.zh.item4`

- 场景与构图：背景、主体位置、景别、视角，以及给文字预留的留白。

## `BRIEF.zh.item5`

- 风格、色彩与光线：媒介风格、主色和冷暖、光线氛围保持统一。

## `BRIEF.zh.item6`

- 画面文字：只出现请求里写明的原文；请求没写文字就不出现任何文字。

## `BRIEF.zh.item7`

- 不要出现：水印、多余或缺失的手指与肢体、杂乱背景、他人商标或签名。

## `BRIEF.en.item1`

Image brief (resolve each item from the user request; where it is silent, choose what suits the purpose, and add no brand colors, logos or in-image text of your own):

## `BRIEF.en.item2`

- Purpose and aspect ratio: compose for the requested use and ratio; without a ratio, use the usual one for that use (cover 16:9, post 3:4 or 1:1, vertical 9:16, icon 1:1, poster 2:3).

## `BRIEF.en.item3`

- Subject: what it is, its state and its action.

## `BRIEF.en.item4`

- Setting and composition: background, subject position, framing, viewpoint, and space reserved for text.

## `BRIEF.en.item5`

- Style, color and light: keep medium, main colors, warmth and lighting mood consistent.

## `BRIEF.en.item6`

- Text in image: only the exact wording the request gives; if it gives none, render no text.

## `BRIEF.en.item7`

- Avoid: watermarks, extra or missing fingers and limbs, cluttered backgrounds, others' trademarks or signatures.

## `normsSection.zh`

设计规范（来自这个 Bot 的工作规范）：

## `normsSection.en`

Design norms (from this Bot's working norms):
