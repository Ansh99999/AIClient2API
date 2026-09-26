export function normalizeCodexInstructions(requestBody) {
    if (!Array.isArray(requestBody.input)) {
        return requestBody;
    }

    const instructionTexts = [];
    requestBody.input = requestBody.input.filter(item => {
        const isMessage = !item?.type || item.type === 'message';
        const isInstructionRole = item?.role === 'system' || item?.role === 'developer';
        if (!isMessage || !isInstructionRole) {
            return true;
        }

        const content = item.content;
        if (typeof content === 'string') {
            instructionTexts.push(content);
        } else if (Array.isArray(content)) {
            for (const part of content) {
                const text = typeof part === 'string' ? part : part?.text;
                if (text) instructionTexts.push(text);
            }
        }
        return false;
    });

    if (instructionTexts.length > 0) {
        const incomingInstructions = instructionTexts.join('\n');
        if (!requestBody.instructions) {
            requestBody.instructions = incomingInstructions;
        } else if (requestBody.instructions !== incomingInstructions) {
            requestBody.instructions = `${requestBody.instructions}\n${incomingInstructions}`;
        }
    }

    return requestBody;
}
