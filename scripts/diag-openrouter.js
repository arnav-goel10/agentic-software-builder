async function test(label, model, apiKey, options = {}) {
    console.log(`\n[${label}] Testing model: ${model}`);

    try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': 'http://localhost:3000',
                'X-Title': 'Dexter-Diagnostic'
            },
            body: JSON.stringify({
                model: model,
                messages: [{ role: 'user', content: 'Say hello' }],
                ...options
            })
        });

        const status = response.status;
        const body = await response.text();
        console.log(`Status: ${status}`);
        if (body.startsWith('{')) {
            const parsed = JSON.parse(body);
            if (status !== 200) {
                console.log(`Error: ${parsed.error?.message || 'No error message'}`);
                if (parsed.error?.metadata?.raw) {
                    console.log(`Raw: ${JSON.stringify(parsed.error.metadata.raw)}`);
                }
            } else {
                console.log(`Success! Provider: ${parsed.provider}`);
            }
        }
        return status === 200;
    } catch (e) {
        console.error(`Fetch failed: ${e.message}`);
        return false;
    }
}

const key1 = process.env.OPENROUTER_API_KEY;

async function run() {
    // Test combinations of parameters that Dexter sends
    const model = 'stepfun/step-3.5-flash:free';

    await test("BASIC", model, key1, { provider: { allow_fallbacks: true } });
    await test("JSON_MODE", model, key1, { provider: { allow_fallbacks: true }, response_format: { type: 'json_object' } });
    await test("PLUGINS", model, key1, { provider: { allow_fallbacks: true }, plugins: [{ id: 'response-healing' }] });
    await test("REASONING", model, key1, { provider: { allow_fallbacks: true }, include_reasoning: true });
    await test("DEXTER_FULL", model, key1, {
        provider: { allow_fallbacks: true },
        response_format: { type: 'json_object' },
        plugins: [{ id: 'response-healing' }],
        include_reasoning: true
    });
}

run().catch(console.error);
