# User registration

In MES, open **Configuration → User** and select **Generate Link** beside **Add User**. This creates a row and switches to **Invited**. Copy the link from that row and share it with the applicant. Use the **Active / Invited** toggle in the breadcrumb bar to switch lists. Invitations and their links remain available after reopening MES. Each invitation is single use and expires 24 hours after creation. The URL uses the same backend address as the MES client (`client/src/shared/server.js`); development links use localhost and must be opened on that machine.

The backend serves `/register`. The applicant supplies a profile photo, full name, email, username and password. JPG, PNG and WebP photos up to 5 MB are decoded and resized to a maximum 512 × 512 JPEG, with metadata removed. Photos are stored in MongoDB as portrait data URLs, so they do not depend on a server's temporary filesystem.

Submission updates the corresponding invited row with the applicant's photo, name, email and username. Its status becomes **Ready to provision**. Select **Provision account** on that row, choose the account role and permission category, and confirm provisioning. The account then appears in **Active** and leaves **Invited**. Alternatively, reject the request. Open links show an **Expired** status after 24 hours; submitted applications remain reviewable after link expiry. Invitations are separate from login accounts until provisioning succeeds.

Provisioning creates the user and marks the registration approved in one MongoDB transaction. It requires the replica-set transaction support already used by MES. A sparse unique `usernameKey` index prevents concurrent creation of new accounts with the same normalized username; existing users do not require a data migration. Existing usernames are checked before creation or renaming. Legacy duplicate usernames, if present, need to be resolved before those accounts can be renamed to the same name.

Invitation tokens contain 10 random URL-safe characters and are carried in the URL fragment rather than server access-log URLs. SHA-256 hashes are used for lookup. To allow administrators to retrieve links from invited rows, the token is also retained in a field excluded from default database selections and returned only as a link by the Admin-only invitation endpoints. This recoverable token is removed on approval or rejection. Older invitations created before link persistence remain usable but their links cannot be recovered from their hashes. Pending passwords use salted scrypt over the existing MES login digest. Both legacy and new passwords remain supported by the socket and HTTP login endpoints. Registration credentials and photos are removed from the pending record when approved or rejected. Only administrators can list registrations or provision accounts. The legacy `/api/login/register` test endpoint is disabled to prevent bypassing this workflow.

Deploy the backend and updated MES client together. Share production links over HTTPS. No email is sent automatically.

Validation:

- Server: `node --test test/userRegistration.test.js test/messageSession.test.js`
- Client: `node --test test/registration.test.cjs test/permissionCategory.test.cjs`
- Browser behavior: `node_modules/.bin/electron test/registrationPage.electron.cjs`
- Client build: `npx --no-install electron-vite build`
