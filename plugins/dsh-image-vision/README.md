# dsh-image-vision — dsh 看图插件

给 dsh 加「看图」能力：

- **工具 `view_image`**：主模型（即使本身不支持图片输入，如 deepseek-v4-flash）也能看图。
  用法：把图片路径传给工具，插件把图片交给**商汤日日新视觉模型 `sensenova-6.8-flash-lite`**
  （OpenAI Vision 兼容接口，`image_url` + base64），返回描述 / 问答 / OCR 的文字结果。

## 原理

```
用户/主模型给出图片路径
  → view_image 读取文件，必要时用 sharp 缩放到长边 ≤2048px
  → POST {baseUrl}/chat/completions，content 里带 image_url(data URI)
  → 商汤视觉模型返回文字 → 工具结果带回主模型上下文
```

## 配置（注册到 profile 的 cordis.patch.yml）

```yaml
- insert:
    - id: dsh-image-vision
      name: 'dsh-image-vision'
      config:
        apiKeyEnv: SHANGTANG_API_KEY   # 凭据引用（~/.dsh/.credentials.yaml 或环境变量）
        baseUrl: https://token.sensenova.cn/v1
        model: sensenova-6.8-flash-lite
        maxTokens: 1024
        maxSide: 2048                  # 图片长边上限（商汤建议 ≤2048）
```

也支持环境变量覆盖：`DSH_IMAGE_VISION_API_KEY_ENV` / `DSH_IMAGE_VISION_BASE_URL` / `DSH_IMAGE_VISION_MODEL`。

## 搭配使用

- 想**主模型本身就能看图**（发图后自动看到，不用手动调工具）：在模型选择器里选商汤路由的
  `sensenova-6.8-flash-lite`（需在 settings.yaml 中为其声明 `input: [text, image]`）。
- 想**保持 deepseek-v4-flash 做主模型**：让它调用 `view_image` 工具即可，例如对它说
  「看一下这个文件 <路径> 里的图」。

## 已知限制

- 依赖商汤 `SHANGTANG_API_KEY`（公测有免费额度）。
- 视觉模型输出为文字：可以描述画面、辨认文字（OCR）、回答图中问题；不能返回修改后的图片。
- opencode-go 路由的 deepseek-v4-flash 实测拒绝图片输入（"Model only supports text input"），
  所以默认主模型必须靠 `sensenova-6.8-flash-lite` 或 `view_image` 工具看图。