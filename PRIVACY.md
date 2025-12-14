# Privacy Policy for Content Extractor Extension

**Last Updated:** 2025-12-14

## Introduction

Welcome to Content Extractor, an AI-powered content extraction and highlighting browser extension by ADI Family. This Privacy Policy explains how we handle your information when you use our extension.

We take your privacy seriously. Our goal is to be transparent about the data we use to provide our service. This extension is designed to function without a central server, meaning your data is primarily stored on your local machine and sent directly to the AI service of your choice.

## Information We Collect

To provide our services, we need to handle the following types of information:

*   **API Keys:** To use the AI-powered features, you must provide your own API keys for third-party services like OpenAI, Anthropic, or Google AI. These keys are stored locally on your computer using the `chrome.storage.local` API and are only used to authenticate your requests with the respective services. **We do not have access to your API keys.**

*   **User Queries:** The questions or instructions you type into the extension (e.g., "find all email addresses") are stored locally using `chrome.storage.local` to preserve your history and improve your user experience.

*   **User Preferences:** Your selected AI provider (e.g., OpenAI, Anthropic) and preferred model (e.g., `claude-sonnet-4-5-20250929`) are saved locally to remember your choices between sessions.

*   **Webpage Content:** To perform highlighting or extraction, the extension processes the content of the active webpage. This includes:
    *   **Page Text (`innerText`):** For the "Highlight" feature, the text content of the page is sent to the AI service you have configured.
    *   **Page HTML (`innerHTML`):** For the "Extract" feature, a portion of the page's HTML is sent to the AI service to generate extraction code.

*   **Model and Provider Data:** The extension fetches a list of available AI models and providers from a public file hosted on our GitHub repository. This data is cached locally on your machine to improve performance.

## How We Use Your Information

Your information is used for the following purposes:

*   **To Provide Core Functionality:** Your API keys, queries, and the content of web pages are used to perform the AI-powered highlighting and data extraction that the extension offers.

*   **To Personalize Your Experience:** We store your preferences, such as the last query and selected model/provider, to make the extension more convenient for you to use.

*   **To Communicate with Third-Party AI Services:** The extension sends the webpage content and your query directly to the API of the third-party AI service you have selected (OpenAI, Anthropic, or Google). You are subject to the terms and privacy policies of that service.

## Data Storage and Security

*   **Local Storage:** All sensitive data, including your API keys and query history, is stored on your local machine using the `chrome.storage.local` API. This storage is private to your browser profile. We do not transmit this data to our own servers.

*   **Security:** While we do not store your data on our servers, we encourage you to protect your API keys. Do not share them publicly and consider using keys with limited usage quotas for third-party applications.

## Third-Party Services

The extension relies on third-party AI providers to function. When you use the extension, your data is sent to the service you select. We recommend you review their privacy policies to understand how they handle your data.

*   **OpenAI:** [Privacy Policy](https://openai.com/policies/privacy-policy)
*   **Anthropic:** [Privacy Policy](https://www.anthropic.com/privacy)
*   **Google:** [Privacy Policy](https://policies.google.com/privacy)

## Data Retention

All data stored locally by the extension (API keys, queries, preferences) remains on your computer until you either clear it from the extension's settings or uninstall the extension.

## Your Rights and Choices

Because we do not have a central database of user information, your rights can be exercised directly by you:

*   **Access and Update:** You can view and update your API keys and other settings directly within the extension's settings panel.
*   **Deletion:** You can clear your query history and saved preferences from the extension's settings. Uninstalling the extension will also remove all locally stored data.

## Changes to This Privacy Policy

We may update this Privacy Policy from time to time. Any changes will be reflected in the "Last Updated" date at the top of this document. We encourage you to review this policy periodically.

## Contact Us

If you have any questions or concerns about this Privacy Policy, please open an issue on our [GitHub repository](https://github.com/adi-family/content-extractor-extension/issues).