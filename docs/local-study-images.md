# Local study images

Use **Insert local image** in a supported editor to choose a PNG, JPEG, WebP or GIF file of up to 2 MiB. The picker checks the content signature and format, then inserts Markdown with embedded raster bytes. SVG and executable content formats are refused.

The filename supplies readable alt text; edit it to describe the figure for learners who cannot see it. The embedded image saves with the Markdown in your learning library and backups. Reopening it does not need the original file, a web connection or an image server. Larger libraries and backups take more space when they contain embedded images.

The picker does not read filesystem paths or upload images to a provider. A corrupt raster that passes its format signature can still fail to decode; the study renderer then shows the image's alt text and unavailable-image message. Format validation is not a full image decoder.

For UI integration, `LocalImagePicker({ onInsert, disabled })` calls the latest `onInsert(markdown)` after validating a selected file. The editor decides the insertion position and saves the resulting Markdown through its existing path. Set the React `key` to the target identity, including the library, draft/note, card and field IDs as applicable. A target change must remount the picker, and the insertion updater must also guard its target IDs. Pending reads are discarded if the picker unmounts or its disabled state changes; ordinary typing and callback rerenders preserve the upload.

The browser-safe `lib/study-image-policy.js` exports `safeRasterDataUri(value)` and `MAX_LOCAL_IMAGE_BYTES` for shared client/server validation. The helper returns a valid canonical bounded raster URI, or `null`; `safeStudyImage` accepts these URIs alongside its existing HTTP(S) image policy.
