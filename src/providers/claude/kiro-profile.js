export function isKiroBuilderIdAuth(authMethod) {
    const normalized = String(authMethod || '').toLowerCase().replace(/[_\s]/g, '-');
    return normalized === 'builder-id' || normalized === 'builderid';
}

/**
 * AWS Builder ID and Enterprise IdC use the same OIDC credential shape, so a
 * builder-id label alone cannot determine whether a profile is discoverable.
 * Try discovery for every profileless, non-social credential; callers treat a
 * failed discovery as a soft failure and retain the profileless fallback.
 */
export function shouldDiscoverKiroProfile({ isSocialAuth, profileArn }) {
    const hasProfileArn = typeof profileArn === 'string' && profileArn.trim() !== '';
    return !hasProfileArn && !isSocialAuth;
}

/**
 * Keep any real profile supplied or discovered for an AWS OIDC credential.
 * For a profileless Builder ID credential, never manufacture or persist a
 * placeholder ARN.
 */
export function resolveKiroRequestProfileArn(authMethod, profileArn) {
    if (typeof profileArn === 'string' && profileArn.trim() !== '') {
        return profileArn;
    }
    if (isKiroBuilderIdAuth(authMethod)) {
        return undefined;
    }
    return profileArn;
}

/**
 * The q.* generation endpoint can require profileArn, while the legacy
 * CodeWhisperer endpoint accepts Builder ID without one. Route only profileless
 * Builder ID requests; credentials with a real profile keep the normal route.
 */
export function shouldRouteBuilderToCodeWhisperer({ authMethod, profileArn, requestUrl }) {
    if (!isKiroBuilderIdAuth(authMethod) ||
        (typeof profileArn === 'string' && profileArn.trim() !== '')) {
        return false;
    }

    try {
        const url = new URL(requestUrl);
        return /^q\.[a-z0-9-]+\.amazonaws\.com$/i.test(url.hostname) &&
            url.pathname.toLowerCase() === '/generateassistantresponse';
    } catch {
        return false;
    }
}
