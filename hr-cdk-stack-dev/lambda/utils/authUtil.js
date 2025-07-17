// lambda/utils/authUtil.js

/**
 * Extracts the user's application-specific employeeId from the Cognito token claims.
 * It prioritizes the 'custom:empId' attribute, falling back to other standard claims.
 * This is the primary function for identifying which employee record a user corresponds to.
 * @param {object} event - The API Gateway Lambda event object.
 * @returns {string | null} The employeeId from the token, or null if not found.
 */
const getRequestingUser = (event) => {
    const claims = event.requestContext?.authorizer?.claims;

    if (claims) {
        // --- THIS IS THE NEW, PRIORITIZED LOGIC ---
        // 1. Prioritize the custom:empId attribute, as it's the direct link to our database.
        if (claims['custom:empId']) {
            return claims['custom:empId'];
        }
        // ------------------------------------------

        // 2. Fallback to standard claims if the custom one isn't present.
        // 'sub' is the best fallback as it's guaranteed to be unique.
        const fallbackIdentity = claims.sub || claims['cognito:username'] || claims.email;
        if (fallbackIdentity) {
            console.warn(`Could not find 'custom:empId' in token. Falling back to standard claim: ${fallbackIdentity}`);
            return fallbackIdentity;
        }
    }

    console.error('Could not determine any user identity from the event context.');
    return null; // Return null when no identity can be found.
};

/**
 * Extracts the user's role from the 'custom:role' attribute in the Cognito token claims.
 * @param {object} event - The API Gateway Lambda event object.
 * @returns {string | null} The user's role (e.g., 'hr_admin') or null if not found.
 */
const getUserRole = (event) => {
    const claims = event.requestContext?.authorizer?.claims;
    const role = claims ? claims['custom:role'] : null;
    if (!role) {
        console.warn("User role ('custom:role') not found in Cognito token claims.");
    }
    return role;
};

/**
 * Enforces Role-Based Access Control (RBAC) by checking if the user's role is in an allowed list.
 * @param {object} event - The API Gateway Lambda event object.
 * @param {string[]} allowedRoles - An array of role strings that are permitted to access the resource.
 * @returns {boolean} True if the user's role is in the allowed list, false otherwise.
 */
const isAuthorized = (event, allowedRoles) => {
    const userRole = getUserRole(event);
    const requestingUser = getRequestingUser(event); // This will now get the empId

    if (!userRole) {
        console.error(`Authorization failed for user '${requestingUser || 'Unknown'}': No role found in token.`);
        return false;
    }

    if (allowedRoles.includes(userRole)) {
        console.log(`Authorization successful for user '${requestingUser}' with role '${userRole}'.`);
        return true;
    } else {
        console.error(`Authorization FAILED for user '${requestingUser}'. Role '${userRole}' is not in the allowed list: [${allowedRoles.join(', ')}].`);
        return false;
    }
};

/**
 * Checks if the user has permission to change WBS codes based on a custom Cognito attribute.
 * @param {object} event - The API Gateway Lambda event object.
 * @returns {boolean} True if the 'custom:wbsChange' attribute is 'true', false otherwise.
 */
const hasWbsPermission = (event) => {
    const claims = event.requestContext?.authorizer?.claims;
    const canChangeWbs = claims ? claims['custom:wbsChange'] === 'true' : false;
    
    if (!canChangeWbs) {
        const requestingUser = getRequestingUser(event); // Use existing helper for logging
        console.warn(`WBS Change Denied: User '${requestingUser}' does not have 'custom:wbsChange' permission set to 'true'.`);
    }

    return canChangeWbs;
};

module.exports = {
    getRequestingUser,
    isAuthorized,
    getUserRole,
    hasWbsPermission,
};