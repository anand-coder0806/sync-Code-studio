const AI_HTTP_TIMEOUT_MS = 8000;

const buildSuggestions = (message) => {
  const text = String(message || '').toLowerCase();

  if (text.includes('save')) {
    return [
      { label: 'Save current file', action: 'save' },
      { label: 'Save all', action: 'saveAll' },
    ];
  }

  if (text.includes('run') || text.includes('execute') || text.includes('debug')) {
    return [
      { label: 'Run code', action: 'run' },
      { label: 'Open terminal', action: 'toggleTerminal' },
    ];
  }

  if (text.includes('file') || text.includes('open') || text.includes('new')) {
    return [
      { label: 'New file', action: 'newFile' },
      { label: 'Open file', action: 'openFile' },
      { label: 'Go to file', action: 'goToFile' },
    ];
  }

  return [
    { label: 'Open file', action: 'openFile' },
    { label: 'Run code', action: 'run' },
    { label: 'Explain this error', action: 'explainError' },
  ];
};

const buildFallbackReply = ({ message, fileName, language, projectName, fileCount, readOnlyMode }) => {
  const text = String(message || '').trim();
  const lowered = text.toLowerCase();

  if (!text) {
    return 'Ask me anything about this workspace. I can help with files, running code, debugging, and quick fixes.';
  }

  if (lowered.includes('error') || lowered.includes('exception') || lowered.includes('stack trace')) {
    return [
      'To explain this error quickly, share the exact error line and stack snippet.',
      'I will break it down into: root cause, fix, and verification steps.',
      '',
      'Template:',
      '1. Error summary',
      '2. Why it happened',
      '3. Minimal fix',
      '4. How to confirm it is fixed',
    ].join('\n');
  }

  if (lowered.includes('snippet') || lowered.includes('example') || lowered.includes('code')) {
    const lang = String(language || 'javascript').toLowerCase();
    if (lang === 'python') {
      return '```python\ndef greet(name: str) -> str:\n    return f"Hello, {name}"\n\nprint(greet("team"))\n```';
    }
    if (lang === 'java') {
      return '```java\npublic class Main {\n  public static void main(String[] args) {\n    System.out.println("Hello, team");\n  }\n}\n```';
    }
    return '```javascript\nfunction greet(name) {\n  return `Hello, ${name}`;\n}\n\nconsole.log(greet("team"));\n```';
  }

  if (lowered.includes('status') || lowered.includes('workspace')) {
    return `Workspace: project ${projectName || 'N/A'}, file ${fileName || 'untitled'}, language ${language || 'text'}, files ${Number(fileCount) || 0}, mode ${readOnlyMode ? 'read-only' : 'write'}.`;
  }

  if (lowered.includes('save')) {
    return readOnlyMode
      ? 'Read-only mode is active, so saving is blocked. Ask an admin to switch to write mode.'
      : 'Use Save for current file or Save All from the File menu. I can also help with autosave strategy.';
  }

  if (lowered.includes('run') || lowered.includes('execute')) {
    return `Use Run Code to execute ${language || 'the current language'} in ${fileName || 'the active file'}. If dependencies are missing, the output panel will show install hints.`;
  }

  return 'I can help with coding questions, code snippets, and error explanations. Try: "@ai explain this TypeError" or "@ai generate a Java DFS example".';
};

const withTimeout = async (promiseFactory, timeoutMs) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await promiseFactory(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
};

const callOpenAI = async ({ apiKey, model, systemPrompt, userPrompt }) => {
  const response = await withTimeout(
    (signal) => fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal,
    }),
    AI_HTTP_TIMEOUT_MS
  );

  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${response.status}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  return String(text || '').trim();
};

const callGemini = async ({ apiKey, model, systemPrompt, userPrompt }) => {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await withTimeout(
    (signal) => fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: `${systemPrompt}\n\n${userPrompt}` },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
        },
      }),
      signal,
    }),
    AI_HTTP_TIMEOUT_MS
  );

  if (!response.ok) {
    throw new Error(`Gemini request failed: ${response.status}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((part) => part?.text || '').join('\n') || '';
  return String(text || '').trim();
};

const generateAssistantReply = async ({ message, fileName = '', language = '', projectName = '', fileCount = 0, readOnlyMode = false }) => {
  const prompt = String(message || '').trim();
  const systemPrompt = [
    'You are an IDE coding assistant inside a collaborative chat.',
    'Answer concisely and accurately.',
    'When the user asks for code, include runnable examples in fenced code blocks with language tags.',
    'When the user asks about errors, explain root cause, fix, and verification steps.',
    'Never include markdown outside practical headings and code blocks.',
  ].join(' ');

  const userPrompt = [
    `Question: ${prompt || '(empty)'}`,
    `Context: file=${fileName || 'n/a'}, language=${language || 'n/a'}, project=${projectName || 'n/a'}, fileCount=${Number(fileCount) || 0}, readOnly=${Boolean(readOnlyMode)}`,
  ].join('\n');

  const openAiApiKey = process.env.OPENAI_API_KEY;
  const openAiModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const geminiModel = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

  if (openAiApiKey) {
    try {
      const reply = await callOpenAI({
        apiKey: openAiApiKey,
        model: openAiModel,
        systemPrompt,
        userPrompt,
      });
      if (reply) {
        return reply;
      }
    } catch (error) {
      console.warn('[chatbot] OpenAI fallback triggered:', error.message);
    }
  }

  if (geminiApiKey) {
    try {
      const reply = await callGemini({
        apiKey: geminiApiKey,
        model: geminiModel,
        systemPrompt,
        userPrompt,
      });
      if (reply) {
        return reply;
      }
    } catch (error) {
      console.warn('[chatbot] Gemini fallback triggered:', error.message);
    }
  }

  return buildFallbackReply({
    message,
    fileName,
    language,
    projectName,
    fileCount,
    readOnlyMode,
  });
};

exports.generateAssistantReply = generateAssistantReply;

exports.getChatbotReply = async (req, res, next) => {
  try {
    const {
      message = '',
      fileName = '',
      language = '',
      projectName = '',
      fileCount = 0,
      readOnlyMode = 'false',
    } = req.query;

    const resolvedReadOnlyMode = ['1', 'true', 'yes', 'on'].includes(String(readOnlyMode).toLowerCase());
    const reply = await generateAssistantReply({
      message,
      fileName,
      language,
      projectName,
      fileCount,
      readOnlyMode: resolvedReadOnlyMode,
    });

    return res.status(200).json({
      success: true,
      reply,
      suggestions: buildSuggestions(message),
    });
  } catch (error) {
    return next(error);
  }
};
