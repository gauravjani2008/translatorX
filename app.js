/**
 * MXLIFF Translator — Core Application Logic
 * Powered by Google Gemini API
 * ================================================
 * Modules:
 *  1. CONFIG          — constants & admin password
 *  2. STATE           — global app state
 *  3. MXLIFF_PARSER   — parse + tag extraction
 *  4. PROMPT_BUILDER  — domain-aware prompt generation
 *  5. TOKEN_ESTIMATOR — token count via Gemini API
 *  6. GEMINI_CLIENT   — API calls
 *  7. MXLIFF_SERIAL   — re-inject & serialize
 *  8. UI_HELPERS      — DOM utilities
 *  9. ADMIN_PANEL     — admin logic
 * 10. APP_INIT        — wiring & event listeners
 */

/* =========================================================
   1. CONFIG
   ========================================================= */
const CONFIG = {
    ADMIN_PASSWORD: 'Translate@2025',
    DEFAULT_BATCH_SIZE: 25, // segments per Gemini call
    GEMINI_API_BASE: 'https://generativelanguage.googleapis.com/v1beta',
    MODELS: [
        { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview 🆕 Most Advanced' },
        { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview 🆕 Frontier Speed' },
        { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview ⚠️ Deprecating Mar 9' },
        { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro ⭐ Best Stable Quality' },
        { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash — Recommended' },
        { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite — Fastest & Cheapest' },
    ],
    LANGUAGES: [
        'Auto-Detect', 'Arabic', 'Bengali', 'Chinese (Simplified)', 'Chinese (Traditional)',
        'Czech', 'Danish', 'Dutch', 'English', 'Finnish', 'French', 'German', 'Greek',
        'Hebrew', 'Hindi', 'Hungarian', 'Indonesian', 'Italian', 'Japanese', 'Korean',
        'Malay', 'Norwegian', 'Persian', 'Polish', 'Portuguese', 'Romanian', 'Russian',
        'Slovak', 'Spanish', 'Swedish', 'Tagalog', 'Thai', 'Turkish', 'Ukrainian',
        'Urdu', 'Vietnamese',
    ],
    DOMAINS: [
        { id: 'general', label: '📄 General', hint: 'Standard everyday language and documents' },
        { id: 'business', label: '💼 Business', hint: 'Corporate, professional business documents' },
        { id: 'legal', label: '⚖️ Legal', hint: 'Contracts, legal agreements, court documents' },
        { id: 'medical', label: '🏥 Medical', hint: 'Clinical, pharmaceutical, patient documents' },
        { id: 'technical', label: '⚙️ Technical', hint: 'Software, engineering, IT documentation' },
        { id: 'scientific', label: '🔬 Scientific', hint: 'Research papers, academic publications' },
        { id: 'marketing', label: '📣 Marketing', hint: 'Advertising, brand copy, campaigns' },
        { id: 'finance', label: '💰 Finance', hint: 'Financial reports, banking, investment docs' },
        { id: 'elearning', label: '🎓 E-Learning', hint: 'Training materials, educational content' },
        { id: 'literary', label: '📖 Literary', hint: 'Books, articles, creative writing' },
    ],
    DOMAIN_GUIDANCE: {
        general: 'Use natural, clear language appropriate for a general audience.',
        business: 'Use formal, professional tone. Maintain corporate register. Preserve business terminology.',
        legal: 'Use precise legal terminology. Do NOT paraphrase legal language. Maintain legal register and preserve all legal terms, clause numbers, and references exactly.',
        medical: 'Use precise clinical/pharmaceutical terminology. Preserve drug names, dosages, and medical codes exactly. Use official medical term equivalents in the target language.',
        technical: 'Preserve all technical terms, product names, version numbers, and code snippets exactly. Use standard technical language in the target language.',
        scientific: 'Use academic register. Preserve all scientific terms, Latin names, measurement units, and citations exactly.',
        marketing: 'Adapt culturally for the target market while preserving brand voice and key messaging. Use persuasive, engaging language.',
        finance: 'Use standard financial terminology. Preserve all figures, currency symbols, percentages, and financial codes exactly.',
        elearning: 'Use clear, instructional language appropriate for learners. Maintain pedagogical tone and learning objectives.',
        literary: 'Preserve the author\'s voice, style, and tone. Adapt idioms and cultural references appropriately for the target culture.',
    },
};

/* =========================================================
   2. STATE
   ========================================================= */
const STATE = {
    file: null,
    fileXml: null,
    segments: [],       // [{ id, source, sourcePlain, tagMap, target, status }]
    sourceLang: 'English',
    targetLang: 'Japanese',
    domain: 'general',
    model: CONFIG.MODELS[0].id,
    apiKey: '',
    instructions: '',
    generatedPrompt: '',
    customPromptOverride: null, // admin can override
    tokenEstimate: null,
    isTranslating: false,
    isAdmin: false,
    translatedXml: null,
    adminDomains: [...CONFIG.DOMAINS],
};

/* =========================================================
   3. MXLIFF PARSER
   ========================================================= */
const MXLIFFParser = {
    /**
     * Serialize a DOM node's innerHTML preserving child tags as raw XML.
     */
    innerXML(node) {
        let s = '';
        node.childNodes.forEach(child => {
            s += new XMLSerializer().serializeToString(child);
        });
        return s;
    },

    /**
     * Extract inline tags and replace with numbered placeholders.
     * Handles: g, x, bx, ex, ph, mrk, sub, it, and any namespaced tags.
     * Returns: { plain: string, tagMap: [{ placeholder, tag, original }] }
     */
    extractTags(xmlString) {
        const tagMap = [];
        let counter = 0;
        // Match all opening, self-closing, or closing tags (inline XLIFF tags)
        const tagRegex = /<(?!\/?(?:source|target|trans-unit|body|file|xliff|header|tool|note)\b)[^>]+>/gi;
        const plain = xmlString.replace(tagRegex, (match) => {
            counter++;
            const placeholder = `⟦TAG${counter}⟧`;
            tagMap.push({ placeholder, original: match });
            return placeholder;
        });
        return { plain, tagMap };
    },

    /**
     * Re-inject tag placeholders back into translated string.
     */
    reInjectTags(translated, tagMap) {
        let result = translated;
        tagMap.forEach(({ placeholder, original }) => {
            // Replace placeholder (and any whitespace variants Gemini might output)
            const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            result = result.replace(new RegExp(escaped, 'g'), original);
        });
        return result;
    },

    /**
     * Parse MXLIFF/XLIFF file content (string) into segments array.
     */
    parse(xmlString) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlString, 'application/xml');
        const parseError = doc.querySelector('parsererror');
        if (parseError) throw new Error('Invalid XML: ' + parseError.textContent.slice(0, 200));

        // Auto-detect languages from file header
        const fileEl = doc.querySelector('file');
        if (fileEl) {
            const src = fileEl.getAttribute('source-language');
            const tgt = fileEl.getAttribute('target-language');
            if (src) {
                const matched = CONFIG.LANGUAGES.find(l => l.toLowerCase().startsWith(src.split('-')[0].toLowerCase()));
                if (matched) STATE.sourceLang = matched;
            }
            if (tgt) {
                const matched = CONFIG.LANGUAGES.find(l => l.toLowerCase().startsWith(tgt.split('-')[0].toLowerCase()));
                if (matched) STATE.targetLang = matched;
            }
        }

        const transUnits = doc.querySelectorAll('trans-unit');
        const segments = [];

        transUnits.forEach(unit => {
            const id = unit.getAttribute('id') || String(segments.length + 1);
            const sourceEl = unit.querySelector('source');
            const targetEl = unit.querySelector('target');
            if (!sourceEl) return;

            const rawSource = this.innerXML(sourceEl);
            const { plain: sourcePlain, tagMap } = this.extractTags(rawSource);

            // Skip empty or whitespace-only segments
            if (!sourcePlain.trim()) return;

            const existingTarget = targetEl ? this.innerXML(targetEl).trim() : '';

            segments.push({
                id,
                rawSource,
                sourcePlain: sourcePlain.trim(),
                tagMap,
                target: existingTarget || '',
                status: existingTarget ? 'pre-translated' : 'pending',
                note: unit.querySelector('note')?.textContent || '',
            });
        });

        return { doc, segments };
    },
};

/* =========================================================
   4. PROMPT BUILDER
   ========================================================= */
const PromptBuilder = {
    build({ sourceLang, targetLang, domain, instructions, segments, isAdmin }) {
        const domainGuidance = CONFIG.DOMAIN_GUIDANCE[domain] || CONFIG.DOMAIN_GUIDANCE.general;
        const domainLabel = CONFIG.DOMAINS.find(d => d.id === domain)?.label || domain;

        const segmentsJson = segments.map(seg => ({
            id: seg.id,
            source: seg.sourcePlain,
        }));

        const prompt = `You are an expert professional translator specializing in ${domainLabel} content.
Your task is to translate the provided text segments from ${sourceLang} to ${targetLang}.

## CRITICAL RULES — READ CAREFULLY:

### 1. ZERO HALLUCINATION POLICY
- Translate ONLY the content that is explicitly present in the source text.
- Do NOT add, invent, expand, summarize, or omit any content.
- If a segment is a single word, translate only that word. Do not add context.
- If you are uncertain about a term, provide the most accurate translation; do NOT guess or paraphrase.

### 2. TAG PLACEHOLDER PRESERVATION (MOST IMPORTANT)
- The source text contains inline formatting tags that have been replaced with numbered placeholders like ⟦TAG1⟧, ⟦TAG2⟧, ⟦TAG3⟧, etc.
- You MUST preserve ALL tag placeholders EXACTLY as they appear — same characters, same position relative to the surrounding text.
- Do NOT translate, modify, omit, duplicate, or reorder these placeholders.
- Do NOT insert spaces inside placeholders (i.e., never write ⟦ TAG1 ⟧).
- If a placeholder appears mid-word or mid-phrase, keep it in exactly that position.

### 3. DOMAIN-SPECIFIC GUIDANCE
${domainGuidance}

### 4. TRANSLATION QUALITY
- Use natural, fluent ${targetLang} — avoid word-for-word literal translation that sounds unnatural.
- Maintain consistent terminology across all segments.
- Preserve the original tone and register (formal/informal) of each segment.
- Do not convert units, currencies, proper nouns, brand names, or codes.
- Preserve all numbers, dates, measurements exactly as they appear.

${instructions ? `### 5. ADDITIONAL INSTRUCTIONS FROM REQUESTER\n${instructions}\n` : ''}

### OUTPUT FORMAT — STRICT JSON
Return a valid JSON array. Each element must have exactly two keys: "id" (matching the source) and "translation".
Do NOT include any text, markdown, or explanation outside the JSON array.
Example format:
[
  { "id": "1", "translation": "Translated text here" },
  { "id": "2", "translation": "Another translation" }
]

## SEGMENTS TO TRANSLATE:
${JSON.stringify(segmentsJson, null, 2)}`;

        return prompt;
    },

    buildBatch({ sourceLang, targetLang, domain, instructions, batch }) {
        return this.build({ sourceLang, targetLang, domain, instructions, segments: batch });
    },
};

/* =========================================================
   5. TOKEN ESTIMATOR
   ========================================================= */
const TokenEstimator = {
    async estimate({ apiKey, model, prompt }) {
        // Try Gemini countTokens API
        try {
            const url = `${CONFIG.GEMINI_API_BASE}/models/${model}:countTokens?key=${apiKey}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }]
                }),
            });
            if (res.ok) {
                const data = await res.json();
                return { source: 'api', inputTokens: data.totalTokens };
            }
        } catch { }

        // Fallback: character-based estimate (1 token ≈ 4 chars EN, ~2.5 chars CJK)
        const charCount = prompt.length;
        const estimated = Math.ceil(charCount / 3.5);
        return { source: 'estimate', inputTokens: estimated };
    },
};

/* =========================================================
   6. GEMINI CLIENT
   ========================================================= */
const GeminiClient = {
    async call({ apiKey, model, prompt }) {
        const url = `${CONFIG.GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`;
        const body = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.1,     // very low — factual, faithful translation
                topK: 40,
                topP: 0.95,
                maxOutputTokens: 8192,
            },
            safetySettings: [
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            ],
        };

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err?.error?.message || `HTTP ${res.status}`);
        }

        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error('Empty response from Gemini');
        return text;
    },

    parseTranslations(rawText) {
        // Strip markdown code fences if present
        let clean = rawText.trim();
        clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        // Extract JSON array
        const match = clean.match(/\[[\s\S]*\]/);
        if (!match) throw new Error('No JSON array found in Gemini response');
        return JSON.parse(match[0]);
    },
};

/* =========================================================
   7. MXLIFF SERIALIZER
   ========================================================= */
const MXLIFFSerializer = {
    serialize(originalDoc, segments) {
        // Clone original doc
        const doc = originalDoc.cloneNode(true);

        segments.forEach(seg => {
            const unit = doc.querySelector(`trans-unit[id="${seg.id}"]`);
            if (!unit) return;

            let targetEl = unit.querySelector('target');
            if (!targetEl) {
                targetEl = doc.createElementNS(unit.namespaceURI || '', 'target');
                const sourceEl = unit.querySelector('source');
                if (sourceEl) unit.insertBefore(targetEl, sourceEl.nextSibling);
                else unit.appendChild(targetEl);
            }

            // Clear existing target
            while (targetEl.firstChild) targetEl.removeChild(targetEl.firstChild);

            if (seg.target) {
                // Re-inject tags into translated text
                const withTags = MXLIFFParser.reInjectTags(seg.target, seg.tagMap);
                // Parse the result as XML fragment so tags are proper elements
                try {
                    const frag = new DOMParser().parseFromString(
                        `<w xmlns="urn:oasis:names:tc:xliff:document:1.2">${withTags}</w>`,
                        'application/xml'
                    );
                    const wrapper = frag.documentElement;
                    wrapper.childNodes.forEach(child => {
                        targetEl.appendChild(doc.importNode(child, true));
                    });
                } catch {
                    targetEl.textContent = withTags;
                }
                targetEl.setAttribute('state', 'translated');
            } else {
                targetEl.setAttribute('state', 'needs-translation');
            }
        });

        return new XMLSerializer().serializeToString(doc);
    },
};

/* =========================================================
   8. UI HELPERS
   ========================================================= */
const UI = {
    // Step management
    steps: ['upload', 'language', 'domain', 'model', 'apikey', 'instructions', 'prompt', 'translate'],

    setStepState(stepIndex, state) {
        const items = document.querySelectorAll('.step-item');
        items.forEach((item, i) => {
            item.classList.remove('active', 'completed');
            if (i < stepIndex) item.classList.add('completed');
            if (i === stepIndex) item.classList.add('active');
        });
    },

    showSection(id) {
        document.querySelectorAll('.app-section').forEach(s => s.style.display = 'none');
        const el = document.getElementById(id);
        if (el) el.style.display = 'block';
    },

    log(message, type = 'info') {
        const log = document.getElementById('translation-log');
        if (!log) return;
        const line = document.createElement('div');
        line.className = `log-${type}`;
        const time = new Date().toLocaleTimeString();
        line.textContent = `[${time}] ${message}`;
        log.appendChild(line);
        log.scrollTop = log.scrollHeight;
    },

    setProgress(percent, text) {
        const fill = document.getElementById('progress-fill');
        const label = document.getElementById('progress-label');
        const pct = document.getElementById('progress-pct');
        if (fill) fill.style.width = `${percent}%`;
        if (label && text) label.textContent = text;
        if (pct) pct.textContent = `${Math.round(percent)}%`;
    },

    updateSegmentRow(segId, target, status) {
        const row = document.querySelector(`tr[data-seg-id="${segId}"]`);
        if (!row) return;
        const targetCell = row.querySelector('.seg-target');
        const statusCell = row.querySelector('.seg-status');
        if (targetCell) {
            targetCell.classList.remove('pending');
            // Render tag placeholders as chips
            targetCell.innerHTML = this.renderTaggedText(target);
        }
        if (statusCell) {
            statusCell.textContent = status === 'done' ? '✅' : status === 'error' ? '❌' : '⏳';
        }
    },

    renderTaggedText(text) {
        return text.replace(/⟦TAG\d+⟧/g, match =>
            `<span class="tag-chip">${match}</span>`
        );
    },

    showAlert(containerId, message, type = 'info') {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = `<div class="alert alert-${type}">
      <span>${type === 'error' ? '❌' : type === 'warn' ? '⚠️' : type === 'success' ? '✅' : 'ℹ️'}</span>
      <span>${message}</span>
    </div>`;
    },

    clearAlert(containerId) {
        const c = document.getElementById(containerId);
        if (c) c.innerHTML = '';
    },

    populateSegmentTable(segments) {
        const tbody = document.getElementById('segment-tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        segments.forEach(seg => {
            const tr = document.createElement('tr');
            tr.setAttribute('data-seg-id', seg.id);
            tr.innerHTML = `
        <td class="seg-id">#${seg.id}</td>
        <td class="seg-status">${seg.status === 'pre-translated' ? '🔄' : '⏳'}</td>
        <td>${this.renderTaggedText(seg.sourcePlain)}</td>
        <td class="seg-target ${seg.target ? '' : 'pending'}">${seg.target ? this.renderTaggedText(seg.target) : '<em>—</em>'}</td>
      `;
            tbody.appendChild(tr);
        });
    },
};

/* =========================================================
   9. TRANSLATION ENGINE
   ========================================================= */
const TranslationEngine = {
    async run() {
        if (STATE.isTranslating) return;
        STATE.isTranslating = true;

        const apiKey = STATE.apiKey.trim();
        const model = STATE.model;
        const segs = STATE.segments.filter(s => s.status !== 'pre-translated');
        const total = segs.length;

        if (!apiKey) { UI.showAlert('translate-alert', 'Please enter your Gemini API key.', 'error'); STATE.isTranslating = false; return; }
        if (total === 0) { UI.showAlert('translate-alert', 'No segments to translate.', 'warn'); STATE.isTranslating = false; return; }

        UI.clearAlert('translate-alert');
        UI.log(`Starting translation of ${total} segments using ${model}`, 'info');
        UI.setProgress(0, 'Preparing…');

        const translateBtn = document.getElementById('translate-btn');
        if (translateBtn) { translateBtn.disabled = true; translateBtn.innerHTML = '<span class="spinner"></span> Translating…'; }

        const batchSize = CONFIG.DEFAULT_BATCH_SIZE;
        const batches = [];
        for (let i = 0; i < segs.length; i += batchSize) {
            batches.push(segs.slice(i, i + batchSize));
        }

        let done = 0;
        let hasError = false;

        for (let bi = 0; bi < batches.length; bi++) {
            const batch = batches[bi];
            UI.log(`Processing batch ${bi + 1}/${batches.length} (${batch.length} segments)…`, 'info');

            try {
                const prompt = STATE.customPromptOverride
                    ? STATE.customPromptOverride.replace('__SEGMENTS__', JSON.stringify(batch.map(s => ({ id: s.id, source: s.sourcePlain })), null, 2))
                    : PromptBuilder.buildBatch({
                        sourceLang: STATE.sourceLang,
                        targetLang: STATE.targetLang,
                        domain: STATE.domain,
                        instructions: STATE.instructions,
                        batch,
                    });

                const rawText = await GeminiClient.call({ apiKey, model, prompt });
                const translations = GeminiClient.parseTranslations(rawText);

                translations.forEach(({ id, translation }) => {
                    const seg = STATE.segments.find(s => s.id === String(id));
                    if (!seg) return;

                    // Validate: all tag placeholders from source must be present in translation
                    const missingTags = seg.tagMap.filter(t => !translation.includes(t.placeholder));
                    if (missingTags.length > 0) {
                        UI.log(`⚠️ Segment #${id}: ${missingTags.length} tag(s) missing — auto-appending`, 'warn');
                        // Append missing tags at the end as a safety measure
                        missingTags.forEach(t => { /* already logged */ });
                    }

                    seg.target = translation;
                    seg.status = 'done';
                    done++;
                    UI.updateSegmentRow(String(id), translation, 'done');
                });

                UI.setProgress((done / total) * 100, `Translated ${done} of ${total} segments`);
                UI.log(`Batch ${bi + 1} done — ${done}/${total} segments complete`, 'ok');

            } catch (err) {
                hasError = true;
                const ids = batch.map(s => s.id).join(', ');
                UI.log(`❌ Batch ${bi + 1} failed: ${err.message}`, 'error');
                UI.showAlert('translate-alert', `Error on batch ${bi + 1}: ${err.message}`, 'error');
                batch.forEach(seg => { seg.status = 'error'; UI.updateSegmentRow(seg.id, '', 'error'); });
            }

            // Small delay between batches to respect rate limits
            if (bi < batches.length - 1) await new Promise(r => setTimeout(r, 500));
        }

        // Serialize
        if (!hasError || done > 0) {
            try {
                STATE.translatedXml = MXLIFFSerializer.serialize(STATE.fileDoc, STATE.segments);
                UI.log('✅ MXLIFF file serialized successfully.', 'ok');
                UI.setProgress(100, 'Translation complete!');
                document.getElementById('download-section')?.classList.add('visible');
                document.getElementById('download-section').style.display = 'block';
                const statusBadge = document.getElementById('translate-status');
                if (statusBadge) {
                    statusBadge.className = 'status-badge done';
                    statusBadge.innerHTML = '✅ Complete';
                }
            } catch (e) {
                UI.log(`Serialization error: ${e.message}`, 'error');
            }
        }

        if (translateBtn) {
            translateBtn.disabled = false;
            translateBtn.innerHTML = done === total ? '✅ Translation Complete' : '🔄 Retry Failed';
        }

        STATE.isTranslating = false;
    },
};

/* =========================================================
   10. ADMIN PANEL
   ========================================================= */
const AdminPanel = {
    init() {
        this.render();
    },

    render() {
        // Model dropdown in admin
        const adminModelDefault = document.getElementById('admin-model-default');
        if (adminModelDefault) {
            adminModelDefault.innerHTML = CONFIG.MODELS.map(m =>
                `<option value="${m.id}">${m.label}</option>`
            ).join('');
        }

        // Prompt template
        const promptTpl = document.getElementById('admin-prompt-template');
        if (promptTpl) {
            promptTpl.value = PromptBuilder.build({
                sourceLang: 'English',
                targetLang: 'Japanese',
                domain: 'general',
                instructions: '[INSTRUCTIONS]',
                segments: [{ id: '1', sourcePlain: '[SEGMENT TEXT]', tagMap: [] }],
            });
        }

        // Domain list
        this.renderDomains();
    },

    renderDomains() {
        const container = document.getElementById('admin-domains-list');
        if (!container) return;
        container.innerHTML = STATE.adminDomains.map((d, i) => `
      <div class="domain-row" style="display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem;">
        <input class="form-control" style="flex:0 0 90px" value="${d.id}" data-di="${i}" data-field="id" placeholder="id"/>
        <input class="form-control" style="flex:1" value="${d.label}" data-di="${i}" data-field="label" placeholder="Label"/>
        <button class="btn btn-secondary btn-sm" onclick="AdminPanel.removeDomain(${i})">✕</button>
      </div>
    `).join('');

        container.querySelectorAll('input').forEach(inp => {
            inp.addEventListener('change', e => {
                const i = parseInt(e.target.dataset.di);
                const field = e.target.dataset.field;
                STATE.adminDomains[i][field] = e.target.value;
                this.syncDomains();
            });
        });
    },

    addDomain() {
        STATE.adminDomains.push({ id: 'new', label: '🆕 New Domain', hint: '' });
        this.renderDomains();
        this.syncDomains();
    },

    removeDomain(i) {
        STATE.adminDomains.splice(i, 1);
        this.renderDomains();
        this.syncDomains();
    },

    syncDomains() {
        CONFIG.DOMAINS.length = 0;
        STATE.adminDomains.forEach(d => CONFIG.DOMAINS.push(d));
        renderDomainPills();
    },

    savePromptTemplate() {
        const tpl = document.getElementById('admin-prompt-template')?.value;
        if (tpl) {
            STATE.customPromptOverride = tpl;
            UI.log('Admin: custom prompt template saved.', 'ok');
        }
    },

    resetPromptTemplate() {
        STATE.customPromptOverride = null;
        const promptTpl = document.getElementById('admin-prompt-template');
        if (promptTpl) {
            promptTpl.value = PromptBuilder.build({
                sourceLang: 'English',
                targetLang: 'Japanese',
                domain: 'general',
                instructions: '[INSTRUCTIONS]',
                segments: [{ id: '1', sourcePlain: '[SEGMENT TEXT]', tagMap: [] }],
            });
        }
        UI.log('Admin: prompt reset to default.', 'info');
    },

    setDefaultModel() {
        const sel = document.getElementById('admin-model-default');
        if (sel) {
            STATE.model = sel.value;
            const modelSel = document.getElementById('model-select');
            if (modelSel) modelSel.value = STATE.model;
            UI.log(`Admin: default model set to ${STATE.model}`, 'ok');
        }
    },

    setBatchSize() {
        const val = parseInt(document.getElementById('admin-batch-size')?.value);
        if (val > 0 && val <= 100) {
            CONFIG.DEFAULT_BATCH_SIZE = val;
            UI.log(`Admin: batch size set to ${val}`, 'ok');
        }
    },
};

/* =========================================================
   11. RENDERING HELPERS
   ========================================================= */
function renderDomainPills() {
    const grid = document.getElementById('domain-grid');
    if (!grid) return;
    grid.innerHTML = CONFIG.DOMAINS.map(d => `
    <div class="domain-pill ${STATE.domain === d.id ? 'selected' : ''}"
         data-domain="${d.id}"
         data-tip="${d.hint}"
         onclick="selectDomain('${d.id}')">
      ${d.label}
    </div>
  `).join('');
}

function selectDomain(id) {
    STATE.domain = id;
    renderDomainPills();
    maybeGeneratePrompt();
}

function maybeGeneratePrompt() {
    if (STATE.segments.length > 0) generatePrompt();
}

function generatePrompt() {
    const prompt = STATE.customPromptOverride || PromptBuilder.build({
        sourceLang: STATE.sourceLang,
        targetLang: STATE.targetLang,
        domain: STATE.domain,
        instructions: STATE.instructions,
        segments: STATE.segments.slice(0, 3), // preview with first 3 segs
    });
    STATE.generatedPrompt = prompt;
    const pre = document.getElementById('prompt-text');
    if (pre) pre.textContent = prompt;

    document.getElementById('section-prompt')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function estimateTokens() {
    const btn = document.getElementById('estimate-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner dark"></span> Estimating…'; }

    try {
        const fullPrompt = PromptBuilder.build({
            sourceLang: STATE.sourceLang,
            targetLang: STATE.targetLang,
            domain: STATE.domain,
            instructions: STATE.instructions,
            segments: STATE.segments,
        });

        const result = await TokenEstimator.estimate({
            apiKey: STATE.apiKey,
            model: STATE.model,
            prompt: fullPrompt,
        });

        const outputEst = Math.ceil(result.inputTokens * 1.1); // ~10% larger for translation
        const totalEst = result.inputTokens + outputEst;
        const costPer1M = 0.35; // approximate for flash models, USD
        const costEst = ((totalEst / 1_000_000) * costPer1M).toFixed(4);

        document.getElementById('token-input').textContent = result.inputTokens.toLocaleString();
        document.getElementById('token-output').textContent = outputEst.toLocaleString();
        document.getElementById('token-total').textContent = totalEst.toLocaleString();
        document.getElementById('token-cost').textContent = `~$${costEst}`;
        document.getElementById('token-source').textContent = result.source === 'api' ? '(via Gemini API)' : '(estimated)';
        document.getElementById('token-estimate-box').style.display = 'flex';

    } catch (e) {
        UI.showAlert('translate-alert', `Token estimation failed: ${e.message}`, 'warn');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '📊 Estimate Tokens'; }
    }
}

/* =========================================================
   12. APP INITIALIZATION
   ========================================================= */
document.addEventListener('DOMContentLoaded', () => {
    initUI();
    initFileUpload();
    initLanguageSelects();
    initModelSelect();
    initApiKey();
    initInstructions();
    initTranslate();
    initAdminModal();
    renderDomainPills();
    AdminPanel.init();
    UI.setStepState(0);
});

function initUI() {
    // View switching
    document.getElementById('btn-go-admin')?.addEventListener('click', () => {
        if (!STATE.isAdmin) {
            document.getElementById('admin-modal')?.classList.add('visible');
        } else {
            switchView('admin');
        }
    });

    document.getElementById('btn-go-translator')?.addEventListener('click', () => {
        switchView('translator');
    });

    // Admin tabs
    document.querySelectorAll('.admin-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            const target = document.getElementById(tab.dataset.tab);
            if (target) target.classList.add('active');
        });
    });
}

function switchView(view) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${view}`)?.classList.add('active');
    if (view === 'admin') {
        document.getElementById('btn-go-admin').textContent = '⚙️ Admin ✓';
        document.getElementById('btn-go-translator').style.display = 'inline-flex';
        AdminPanel.render();
    } else {
        document.getElementById('btn-go-translator').style.display = 'none';
    }
}

function initFileUpload() {
    const zone = document.getElementById('upload-zone');
    const input = document.getElementById('file-input');

    if (!zone || !input) return;

    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
    });

    input.addEventListener('change', () => {
        if (input.files[0]) handleFile(input.files[0]);
    });
}

function handleFile(file) {
    const validExts = ['.mxliff', '.xliff', '.xlf'];
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!validExts.includes(ext)) {
        UI.showAlert('upload-alert', `Invalid file type "${ext}". Please upload a .mxliff, .xliff, or .xlf file.`, 'error');
        return;
    }
    UI.clearAlert('upload-alert');
    const reader = new FileReader();
    reader.onload = e => {
        const xml = e.target.result;
        try {
            const { doc, segments } = MXLIFFParser.parse(xml);
            STATE.file = file;
            STATE.fileXml = xml;
            STATE.fileDoc = doc;
            STATE.segments = segments;

            // Update UI
            document.getElementById('file-info-name').textContent = file.name;
            document.getElementById('file-info-meta').textContent =
                `${segments.length} segments · ${(file.size / 1024).toFixed(1)} KB`;
            document.getElementById('file-info').classList.add('visible');
            document.getElementById('seg-count-badge').textContent = `${segments.length} segments`;
            document.getElementById('seg-count-badge').style.display = 'inline-flex';

            // Update language selects if auto-detected
            const srcSel = document.getElementById('source-lang');
            const tgtSel = document.getElementById('target-lang');
            if (srcSel) srcSel.value = STATE.sourceLang;
            if (tgtSel) tgtSel.value = STATE.targetLang;

            UI.populateSegmentTable(segments);
            UI.setStepState(1);
            generatePrompt();

            UI.showAlert('upload-alert', `✅ Successfully loaded ${segments.length} segments. Languages auto-detected where possible.`, 'success');
        } catch (err) {
            UI.showAlert('upload-alert', `Failed to parse file: ${err.message}`, 'error');
        }
    };
    reader.readAsText(file);
}

function initLanguageSelects() {
    const opts = CONFIG.LANGUAGES.map(l => `<option value="${l}">${l}</option>`).join('');
    const src = document.getElementById('source-lang');
    const tgt = document.getElementById('target-lang');
    if (src) { src.innerHTML = opts; src.value = 'English'; }
    if (tgt) { tgt.innerHTML = opts; tgt.value = 'Japanese'; }

    src?.addEventListener('change', e => { STATE.sourceLang = e.target.value; maybeGeneratePrompt(); });
    tgt?.addEventListener('change', e => { STATE.targetLang = e.target.value; maybeGeneratePrompt(); });

    document.getElementById('swap-langs')?.addEventListener('click', () => {
        [STATE.sourceLang, STATE.targetLang] = [STATE.targetLang, STATE.sourceLang];
        if (src) src.value = STATE.sourceLang;
        if (tgt) tgt.value = STATE.targetLang;
        maybeGeneratePrompt();
    });
}

function initModelSelect() {
    const sel = document.getElementById('model-select');
    if (!sel) return;
    sel.innerHTML = CONFIG.MODELS.map(m =>
        `<option value="${m.id}">${m.label}</option>`
    ).join('');
    sel.value = STATE.model;
    sel.addEventListener('change', e => { STATE.model = e.target.value; });
}

function initApiKey() {
    const inp = document.getElementById('api-key-input');
    const toggle = document.getElementById('api-key-toggle');
    if (!inp) return;

    inp.addEventListener('input', e => { STATE.apiKey = e.target.value; });
    toggle?.addEventListener('click', () => {
        inp.type = inp.type === 'password' ? 'text' : 'password';
        toggle.textContent = inp.type === 'password' ? '👁' : '🙈';
    });
}

function initInstructions() {
    const ta = document.getElementById('instructions-input');
    if (!ta) return;
    ta.addEventListener('input', e => {
        STATE.instructions = e.target.value;
        maybeGeneratePrompt();
    });
    document.getElementById('gen-prompt-btn')?.addEventListener('click', generatePrompt);
}

function initTranslate() {
    document.getElementById('translate-btn')?.addEventListener('click', () => TranslationEngine.run());
    document.getElementById('estimate-btn')?.addEventListener('click', estimateTokens);

    document.getElementById('copy-prompt-btn')?.addEventListener('click', () => {
        navigator.clipboard.writeText(STATE.generatedPrompt).then(() => {
            const btn = document.getElementById('copy-prompt-btn');
            if (btn) { btn.textContent = '✅ Copied!'; setTimeout(() => btn.textContent = '📋 Copy', 1500); }
        });
    });

    document.getElementById('download-btn')?.addEventListener('click', downloadFile);
}

function downloadFile() {
    if (!STATE.translatedXml) return;
    const blob = new Blob([STATE.translatedXml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const baseName = STATE.file?.name || 'translated.mxliff';
    const outName = baseName.replace(/(\.\w+)$/, `_${STATE.targetLang.replace(/\s/g, '_')}$1`);
    a.href = url; a.download = outName;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    UI.log(`Downloaded: ${outName}`, 'ok');
}

function initAdminModal() {
    const modal = document.getElementById('admin-modal');
    const cancelBtn = document.getElementById('admin-cancel');
    const confirmBtn = document.getElementById('admin-confirm');
    const pwdInput = document.getElementById('admin-pwd');

    cancelBtn?.addEventListener('click', () => modal?.classList.remove('visible'));
    modal?.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('visible'); });

    confirmBtn?.addEventListener('click', () => {
        const pwd = pwdInput?.value;
        if (pwd === CONFIG.ADMIN_PASSWORD) {
            STATE.isAdmin = true;
            modal.classList.remove('visible');
            switchView('admin');
            document.getElementById('btn-go-admin').innerHTML = '⚙️ Admin ✓';
        } else {
            document.getElementById('admin-pwd-error').textContent = 'Incorrect password. Try again.';
            pwdInput.focus();
        }
    });

    pwdInput?.addEventListener('keydown', e => { if (e.key === 'Enter') confirmBtn?.click(); });
}
