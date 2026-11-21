# artifact-detail

Prompt text used by `artifact-detail.ts`. Each `## \`key\`` block is sent to the model exactly as written (blank lines around a block are ignored); `{{name}}` is filled in by the code. After editing, run `pnpm gen:prompts`. Changing a block changes the cached prompt prefix (see docs/prompt-cache.md).

## `artifactCreationMethod.zh`

前端与视觉制作（页面/HTML/SVG/插画/图表/动画）：避免平庸、千篇一律的结果。先定视觉方向：气氛、用 CSS 变量定义的配色、最多两种字体和清楚的字号层级。第一屏是一个有意图的完整构图、有明确视觉重心；用真实具体的内容（标题、说明文字），不用占位；背景要有层次（分层、渐变或纹理），不是一块平色。插画先做出能认出来的轮廓和正确的结构：比例、关节和接触点（坐在座位上、脚踩踏板、手握车把）、遮挡顺序、统一的线宽，再加角色细节。动画做 2–3 个有目的的动作，由同一相位驱动、首尾无缝循环；会动的部分要彼此联动（车轮在转，曲柄、踏板和腿就跟着同一节奏转），不要只动一部分。适配不同屏幕宽度。做完用 browser_open 打开，用 browser_screenshot 按桌面和手机宽度实际看画面（browser_snapshot 只有文字结构，看不到画面），修掉裁切、重叠、结构错误或大片空白再交付。

## `artifactCreationMethod.en`

Frontend and visual work (pages/HTML/SVG/illustration/charts/animation): avoid generic, safe-looking output. First decide a visual direction: mood, a palette defined as CSS variables, at most two typefaces with a clear type scale. Compose the first view as one deliberate composition with a clear focal point; use real, specific content (titles, captions) instead of placeholders; give backgrounds depth (layers, gradients or texture) rather than one flat color. For illustrations, build a recognizable silhouette and correct structure first: proportions, joints and contact points (sitting on the seat, feet on the pedals, hands on the handlebar), occlusion order and consistent line weight, then add character details. For motion, 2-3 purposeful animations driven by one shared phase, looping seamlessly; parts that move must move together (if the wheels turn, the crank, pedals and legs turn with the same rhythm), never just one of them. Make it responsive. Then open it with browser_open and look at the picture with browser_screenshot at desktop and mobile widths (browser_snapshot has only the text structure, not the picture), and fix clipping, overlap, broken structure or empty space before delivering.
