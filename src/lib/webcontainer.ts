import { WebContainer } from "@webcontainer/api";

let webcontainerInstance: Promise<WebContainer> | null = null;

export async function getWebContainer() {
    if (!webcontainerInstance) {
        webcontainerInstance = WebContainer.boot({
            forwardPreviewErrors: true
        });
    }
    return webcontainerInstance;
}
