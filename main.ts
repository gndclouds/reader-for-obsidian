import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
} from "obsidian";

// Remember to rename these classes and interfaces!

interface TextToSpeechSettings {
	voiceService: "system" | "elevenlabs" | "openai";
	playbackVoice: string;
	playbackSpeed: number;
	pitch: number;
	volume: number;
	highlightEnabled: boolean;
	highlightWord: boolean;
	wordColor: string;
	elevenLabsApiKey: string;
	openAIApiKey: string;
	highlightStyle: "background" | "underline";
	highlightAnimation: boolean;
}

const DEFAULT_SETTINGS: TextToSpeechSettings = {
	voiceService: "system",
	playbackVoice: "default",
	playbackSpeed: 1.0,
	pitch: 1.0,
	volume: 1.0,
	highlightEnabled: false,
	highlightWord: false,
	wordColor: "#1f26ea",
	elevenLabsApiKey: "",
	openAIApiKey: "",
	highlightStyle: "underline",
	highlightAnimation: true,
};

interface EditorField {
	provides?: {
		is?: {
			decorations?: boolean;
		};
	};
}

interface EditorHighlight {
	from: any; // Position
	to: any; // Position
	css: string;
}

interface ExtendedEditor extends Editor {
	addHighlight(highlight: EditorHighlight): any;
	removeHighlight(highlight: any): void;
}

export default class TextToSpeechPlugin extends Plugin {
	settings: TextToSpeechSettings;
	private speaking: boolean = false;
	private speechSynthesis: SpeechSynthesis = window.speechSynthesis;
	private currentParagraphEl: any = null;
	private currentWordEl: any = null;
	private currentSentenceEl: any = null;
	private statusBarEl: HTMLElement | null = null;
	private defaultVoice: SpeechSynthesisVoice | null = null;
	private currentParagraphIndex: number = 0;
	private paragraphs: string[] = [];
	private currentAudio: HTMLAudioElement | null = null;
	private isLoading: boolean = false;
	private wordHighlightInterval: number | null = null;

	async onload() {
		await this.loadSettings();

		// Initialize speech synthesis and set default voice
		this.initializeSpeechSynthesis();

		// Add the icon to the page header menu (next to edit/read toggle)
		const ribbonIconEl = this.addRibbonIcon(
			"audio-file",
			"Read aloud",
			async (evt: MouseEvent) => {
				// Prevent multiple clicks while loading
				if (this.isLoading) {
					new Notice("Please wait, audio is being generated...");
					return;
				}

				const activeView =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView) {
					const content = activeView.getViewData();
					await this.speakText(content);
				} else {
					new Notice("No active document to read");
				}
			}
		);

		// Add pause overlay to ribbon icon when playing
		const pauseOverlay = ribbonIconEl.createSpan({
			cls: "tts-pause-overlay",
			attr: { "aria-label": "Pause" },
		});
		pauseOverlay.style.display = "none";

		// Update ribbon icon based on playing state
		this.register(() => {
			const observer = new MutationObserver(() => {
				if (this.speaking && !this.isLoading) {
					pauseOverlay.style.display = "flex";
				} else {
					pauseOverlay.style.display = "none";
				}
			});

			if (this.statusBarEl) {
				observer.observe(this.statusBarEl, {
					childList: true,
					subtree: true,
				});
			}
		});

		// Add navigation commands
		this.addCommand({
			id: "next-paragraph",
			name: "Skip to next paragraph",
			hotkeys: [{ modifiers: ["Ctrl"], key: "}" }],
			callback: () => {
				if (this.speaking) {
					this.skipToParagraph("next");
				}
			},
		});

		this.addCommand({
			id: "previous-paragraph",
			name: "Return to previous paragraph",
			hotkeys: [{ modifiers: ["Ctrl"], key: "{" }],
			callback: () => {
				if (this.speaking) {
					this.skipToParagraph("previous");
				}
			},
		});

		// Add status bar item
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("tts-status-bar-item");
		this.updateStatusBar("Click speaker icon to start reading");

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new TextToSpeechSettingTab(this.app, this));
	}

	private updateStatusBar(text: string) {
		if (!this.statusBarEl) return;

		this.statusBarEl.empty();

		// Back button
		const backButton = this.statusBarEl.createEl("span", {
			cls: "tts-control-button",
			attr: {
				"data-tooltip": "Previous ¶",
			},
		});
		backButton.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>`;
		backButton.addEventListener("click", () => {
			if (this.speaking && !this.isLoading) {
				this.skipToParagraph("previous");
			}
		});

		// Play/Pause/Loading button
		const playPauseButton = this.statusBarEl.createEl("span", {
			cls: "tts-control-button",
			attr: {
				"data-tooltip": this.isLoading
					? "Loading..."
					: this.speaking
					? "Pause"
					: "Play",
			},
		});

		if (this.isLoading) {
			playPauseButton.innerHTML = `<span class="tts-loading-dots"><span></span><span></span><span></span></span>`;
			playPauseButton.style.cursor = "not-allowed";
		} else {
			const isPaused =
				this.settings.voiceService === "system"
					? this.speechSynthesis.paused
					: this.currentAudio?.paused;

			const isPlaying = this.speaking && !isPaused;

			playPauseButton.innerHTML = !isPlaying
				? `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`
				: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;
		}

		playPauseButton.addEventListener("click", async (event) => {
			if (this.isLoading) {
				new Notice("Please wait, audio is being generated...");
				return;
			}

			const activeView =
				this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!activeView) {
				new Notice("No active document to read");
				return;
			}

			// Check for Command (Mac) or Control (Windows/Linux) key
			const isModifierKeyPressed = event.metaKey || event.ctrlKey;

			if (this.speaking && !isModifierKeyPressed) {
				// Normal click - handle pause/resume for all services
				if (this.settings.voiceService === "system") {
					if (this.speechSynthesis.paused) {
						this.speechSynthesis.resume();
					} else {
						this.speechSynthesis.pause();
					}
				} else if (this.currentAudio) {
					if (this.currentAudio.paused) {
						await this.currentAudio.play();
					} else {
						this.currentAudio.pause();
					}
				}
				// Update status bar immediately after state change
				this.updateStatusBar("");
			} else {
				// Either not speaking or modifier key is pressed - start new playback
				if (this.speaking) {
					// Stop current playback
					if (this.settings.voiceService === "system") {
						this.speechSynthesis.cancel();
					} else if (this.currentAudio) {
						this.currentAudio.pause();
						this.currentAudio = null;
					}
					this.speaking = false;
					this.clearHighlights();
				}
				const content = activeView.getViewData();
				await this.speakText(content);
			}
		});

		// Forward button
		const forwardButton = this.statusBarEl.createEl("span", {
			cls: "tts-control-button",
			attr: {
				"data-tooltip": "Next ¶",
			},
		});
		forwardButton.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>`;
		forwardButton.addEventListener("click", () => {
			if (this.speaking && !this.isLoading) {
				this.skipToParagraph("next");
			}
		});

		// Disable navigation buttons during loading
		if (this.isLoading) {
			backButton.style.cursor = "not-allowed";
			backButton.style.opacity = "0.5";
			forwardButton.style.cursor = "not-allowed";
			forwardButton.style.opacity = "0.5";
		}
	}

	async speakText(text: string) {
		// If already loading, prevent new request
		if (this.isLoading) {
			new Notice("Please wait, audio is being generated...");
			return;
		}

		if (this.speaking) {
			// Stop any active speech or audio
			if (this.settings.voiceService === "system") {
				this.speechSynthesis.cancel();
			} else if (this.currentAudio) {
				this.currentAudio.pause();
				this.currentAudio = null;
			}
			this.speaking = false;
			this.isLoading = false;
			this.clearHighlights();
			this.updateStatusBar("");
			return;
		}

		// Set loading state before starting
		this.isLoading = true;
		this.updateStatusBar("");

		try {
			// Set speaking state immediately
			this.speaking = true;

			// Remove frontmatter and properties
			let cleanText = text;

			// Remove YAML frontmatter
			cleanText = cleanText.replace(/^---\n[\s\S]*?\n---\n/, "");

			// Remove Obsidian properties (lines starting with property:)
			cleanText = cleanText
				.split("\n")
				.filter((line) => !line.match(/^[a-zA-Z0-9-_]+::.*$/))
				.join("\n");

			// Remove any extra newlines at the start
			cleanText = cleanText.replace(/^\n+/, "");

			// Use the selected voice service
			switch (this.settings.voiceService) {
				case "system":
					await this.speakWithSystem(cleanText);
					break;
				case "elevenlabs":
					await this.speakWithElevenLabs(cleanText);
					break;
				case "openai":
					await this.speakWithOpenAI(cleanText);
					break;
			}

			// Update status bar after starting
			this.updateStatusBar("");
		} catch (error) {
			console.error("Error starting speech:", error);
			new Notice("Error starting speech. Please try again.");
			this.isLoading = false;
			this.speaking = false;
			this.updateStatusBar("");
		}
	}

	private initializeSpeechSynthesis() {
		// Load voices and set default
		const loadVoices = () => {
			const voices = this.speechSynthesis.getVoices();

			// Try to find the system default voice
			this.defaultVoice = voices.find((voice) => voice.default) || null;

			// If no default voice is found, try to find a suitable English voice
			if (!this.defaultVoice) {
				this.defaultVoice =
					voices.find(
						(voice) =>
							voice.lang.startsWith("en-") ||
							voice.name.toLowerCase().includes("samantha") ||
							voice.name.toLowerCase().includes("alex")
					) ||
					voices[0] ||
					null;
			}

			if (this.defaultVoice) {
				console.log("Selected default voice:", this.defaultVoice.name);
			} else {
				console.warn("No suitable voice found");
			}
		};

		// Load voices immediately in case they're already available
		loadVoices();

		// Also set up the event listener for when voices are loaded asynchronously
		this.speechSynthesis.onvoiceschanged = loadVoices;
	}

	private async speakWithSystem(text: string) {
		console.log("Starting speakWithSystem");
		this.paragraphs = text.split(/\n\s*\n/);
		console.log("Split into paragraphs, count:", this.paragraphs.length);

		const processNextParagraph = () => {
			if (this.currentParagraphIndex >= this.paragraphs.length) {
				this.speaking = false;
				this.isLoading = false;
				this.clearHighlights();
				this.updateStatusBar("");
				return;
			}

			const paragraph = this.paragraphs[this.currentParagraphIndex];
			const utterance = new SpeechSynthesisUtterance(paragraph);
			utterance.rate = this.settings.playbackSpeed;
			utterance.pitch = this.settings.pitch;
			utterance.volume = this.settings.volume;

			if (this.defaultVoice) {
				utterance.voice = this.defaultVoice;
			}

			// Clear loading state when speech starts
			this.isLoading = false;
			this.updateStatusBar("");

			utterance.onerror = (event) => {
				console.error("Speech synthesis error:", event);
				if (
					event.error === "interrupted" ||
					event.error === "canceled"
				) {
					// Don't show error for intentional interruptions
					return;
				}
				if (event.error === "synthesis-failed") {
					// Handle synthesis failure by trying to continue with next paragraph
					console.log("Synthesis failed, attempting next paragraph");
					this.currentParagraphIndex++;
					processNextParagraph();
					return;
				}
				new Notice(`Speech synthesis error: ${event.error}`);
			};

			// Handle word boundaries for highlighting
			utterance.onboundary = (event) => {
				if (event.name === "word" && this.settings.highlightEnabled) {
					const wordIndex = event.charIndex;
					let wordLength = event.charLength || 1;

					// Get the word being spoken and its context
					const text = paragraph.substring(wordIndex);

					// Find the complete word boundaries
					const wordMatch = text.match(/^\S+/);
					if (wordMatch) {
						wordLength = wordMatch[0].length;

						// Only highlight if it's an actual word (not whitespace or punctuation)
						if (wordMatch[0].trim().length > 0) {
							// Add a small delay to ensure synchronization with speech
							setTimeout(() => {
								this.highlightWord(
									this.currentParagraphIndex,
									wordIndex,
									wordLength,
									0
								);
							}, 0);
						}
					}
				}
			};

			utterance.onend = () => {
				if (this.speaking) {
					this.currentParagraphIndex++;
					processNextParagraph();
				}
			};

			this.speechSynthesis.speak(utterance);
		};

		this.speaking = true;
		this.currentParagraphIndex = 0;
		processNextParagraph();
	}

	private async speakWithElevenLabs(text: string) {
		if (!this.settings.elevenLabsApiKey) {
			this.isLoading = false;
			new Notice("Please enter your Eleven Labs API key in settings");
			return;
		}

		// Stop any existing audio
		if (this.currentAudio) {
			this.currentAudio.pause();
			this.currentAudio = null;
		}

		this.speaking = true;
		this.paragraphs = text.split(/\n\s*\n/);
		this.updateStatusBar("");

		const processNextParagraph = async () => {
			if (this.currentParagraphIndex >= this.paragraphs.length) {
				this.speaking = false;
				this.isLoading = false;
				this.clearHighlights();
				this.updateStatusBar("");
				return;
			}

			const paragraph = this.paragraphs[this.currentParagraphIndex];

			try {
				this.isLoading = true;
				this.updateStatusBar("");

				const response = await fetch(
					`https://api.elevenlabs.io/v1/text-to-speech/${this.settings.playbackVoice}`,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"xi-api-key": this.settings.elevenLabsApiKey,
						},
						body: JSON.stringify({
							text: paragraph,
							model_id: "eleven_monolingual_v1",
							voice_settings: {
								stability: 0.5,
								similarity_boost: 0.75,
								speed: this.settings.playbackSpeed,
							},
						}),
					}
				);

				if (!response.ok) {
					throw new Error(`HTTP error! status: ${response.status}`);
				}

				const audioBlob = await response.blob();
				const audioUrl = URL.createObjectURL(audioBlob);
				const audio = new Audio(audioUrl);

				this.isLoading = false;
				this.updateStatusBar("");

				// Add event listeners for audio
				audio.onplay = () => {
					this.speaking = true;
					this.updateStatusBar("");

					// Start word highlighting if enabled
					if (this.settings.highlightEnabled) {
						this.highlightWord(
							this.currentParagraphIndex,
							0,
							paragraph.length,
							0
						);
					}
				};

				audio.onpause = () => {
					this.updateStatusBar("");
				};

				audio.onended = () => {
					URL.revokeObjectURL(audioUrl);
					if (this.speaking) {
						this.currentParagraphIndex++;
						processNextParagraph();
					}
				};

				audio.onerror = (error) => {
					console.error("Audio playback error:", error);
					new Notice("Error playing audio");
					URL.revokeObjectURL(audioUrl);
					this.speaking = false;
					this.isLoading = false;
					this.updateStatusBar("");
				};

				this.currentAudio = audio;
				await audio.play();
			} catch (error) {
				console.error("Error with Eleven Labs API:", error);
				new Notice("Error generating speech with Eleven Labs");
				this.speaking = false;
				this.isLoading = false;
				this.updateStatusBar("");
			}
		};

		this.currentParagraphIndex = 0;
		await processNextParagraph();
	}

	private async speakWithOpenAI(text: string) {
		if (!this.settings.openAIApiKey) {
			this.isLoading = false;
			new Notice("Please enter your OpenAI API key in settings");
			return;
		}

		// Stop any existing audio
		if (this.currentAudio) {
			this.currentAudio.pause();
			this.currentAudio = null;
		}

		this.speaking = true;
		this.paragraphs = text.split(/\n\s*\n/);
		this.updateStatusBar("");

		const processNextParagraph = async () => {
			if (this.currentParagraphIndex >= this.paragraphs.length) {
				this.speaking = false;
				this.isLoading = false;
				this.clearHighlights();
				this.updateStatusBar("");
				return;
			}

			const paragraph = this.paragraphs[this.currentParagraphIndex];

			try {
				this.isLoading = true;
				this.updateStatusBar("");

				const response = await fetch(
					"https://api.openai.com/v1/audio/speech",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${this.settings.openAIApiKey}`,
						},
						body: JSON.stringify({
							model: "tts-1",
							voice: this.settings.playbackVoice,
							input: paragraph,
							speed: this.settings.playbackSpeed,
						}),
					}
				);

				if (!response.ok) {
					throw new Error(`HTTP error! status: ${response.status}`);
				}

				const audioBlob = await response.blob();
				const audioUrl = URL.createObjectURL(audioBlob);
				const audio = new Audio(audioUrl);

				this.isLoading = false;
				this.updateStatusBar("");

				// Add event listeners for audio
				audio.onplay = () => {
					this.speaking = true;
					this.updateStatusBar("");

					// Start word highlighting if enabled
					if (this.settings.highlightEnabled) {
						this.highlightWord(
							this.currentParagraphIndex,
							0,
							paragraph.length,
							0
						);
					}
				};

				audio.onpause = () => {
					this.updateStatusBar("");
				};

				audio.onended = () => {
					URL.revokeObjectURL(audioUrl);
					if (this.speaking) {
						this.currentParagraphIndex++;
						processNextParagraph();
					}
				};

				audio.onerror = (error) => {
					console.error("Audio playback error:", error);
					new Notice("Error playing audio");
					URL.revokeObjectURL(audioUrl);
					this.speaking = false;
					this.isLoading = false;
					this.updateStatusBar("");
				};

				this.currentAudio = audio;
				await audio.play();
			} catch (error) {
				console.error("Error with OpenAI API:", error);
				new Notice("Error generating speech with OpenAI");
				this.speaking = false;
				this.isLoading = false;
				this.updateStatusBar("");
			}
		};

		this.currentParagraphIndex = 0;
		await processNextParagraph();
	}

	private getHighlightStyle(color: string): { css: string } {
		console.log("Getting highlight style for color:", color);

		let css = "";
		const transition = this.settings.highlightAnimation
			? "transition: all 0.3s ease;"
			: "";

		// Ensure we're using the color from settings
		const highlightColor = this.settings.wordColor;
		console.log("Using highlight color from settings:", highlightColor);

		switch (this.settings.highlightStyle) {
			case "background":
				css = `background-color: ${highlightColor}; border-radius: 3px; ${transition}`;
				break;
			case "underline":
				css = `border-bottom: 2px solid ${highlightColor}; ${transition}`;
				break;
			default:
				css = `border-bottom: 2px solid ${highlightColor}; ${transition}`;
		}

		console.log("Generated CSS:", css);
		return { css };
	}

	private findParagraphPosition(
		text: string,
		targetParagraphIndex: number
	): { start: number; end: number } {
		const lines = text.split("\n");
		let offset = 0;
		let paragraphCount = 0;
		let paragraphStart = 0;
		let inParagraph = false;
		let currentText = "";

		console.log(`[Debug] Finding paragraph ${targetParagraphIndex}`);
		console.log(`[Debug] Total lines:`, lines.length);

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmedLine = line.trim();

			// Track the current text for debugging
			currentText = text.substring(0, offset);

			console.log(`[Debug] Line ${i}:`, {
				raw: line,
				trimmed: trimmedLine,
				offset,
				paragraphCount,
				inParagraph,
			});

			if (trimmedLine === "") {
				if (inParagraph) {
					if (paragraphCount === targetParagraphIndex) {
						console.log(`[Debug] Found paragraph end:`, {
							start: paragraphStart,
							end: offset,
							text: text.substring(paragraphStart, offset),
						});
						return { start: paragraphStart, end: offset };
					}
					paragraphCount++;
					inParagraph = false;
				}
			} else {
				if (!inParagraph) {
					inParagraph = true;
					if (paragraphCount === targetParagraphIndex) {
						paragraphStart = offset;
						console.log(
							`[Debug] Starting new paragraph at offset:`,
							offset
						);
					}
				}
			}

			// Add the line length and the newline character
			offset += line.length + 1;
		}

		// Handle last paragraph
		if (inParagraph && paragraphCount === targetParagraphIndex) {
			console.log(`[Debug] Found last paragraph:`, {
				start: paragraphStart,
				end: offset,
				text: text.substring(paragraphStart, offset),
			});
			return { start: paragraphStart, end: offset };
		}

		console.log(
			`[Debug] No paragraph found at index ${targetParagraphIndex}`
		);
		return { start: 0, end: 0 };
	}

	private highlightWord(
		paragraphIndex: number,
		wordStart: number,
		wordLength: number,
		paragraphStart: number
	) {
		if (!this.settings.highlightEnabled || !this.settings.highlightWord) {
			return;
		}

		// Clear previous word highlight
		if (this.currentWordEl) {
			this.currentWordEl.clear();
		}

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const editor = view.editor;
		const text = editor.getValue();

		// Calculate absolute position using the provided paragraph start
		const absolutePosition = paragraphStart + wordStart;

		console.log(`[Debug] Word highlighting:`, {
			paragraphIndex,
			paragraphStart,
			wordStart,
			absolutePosition,
			wordText: text.substring(
				absolutePosition,
				absolutePosition + wordLength
			),
		});

		// Validate position
		if (
			absolutePosition >= text.length ||
			absolutePosition + wordLength > text.length
		) {
			console.warn("Invalid word position:", {
				absolutePosition,
				wordLength,
				textLength: text.length,
			});
			return;
		}

		// Calculate positions
		const from = editor.offsetToPos(absolutePosition);
		const to = editor.offsetToPos(absolutePosition + wordLength);

		try {
			// Use Obsidian's built-in editor API for highlighting
			editor.setSelection(from, to);

			// Store reference for cleanup
			this.currentWordEl = {
				clear: () => {
					const cursor = editor.getCursor();
					editor.setSelection(cursor, cursor);
				},
			};
		} catch (error) {
			console.warn("Error applying highlight:", error);
		}
	}

	private highlightSentence(
		paragraphIndex: number,
		sentenceStart: number,
		sentenceLength: number
	) {
		// Since we're removing sentence highlighting, just return
		return;
	}

	private clearHighlights() {
		if (this.currentParagraphEl) {
			this.currentParagraphEl.clear();
			this.currentParagraphEl = null;
		}
		if (this.currentWordEl) {
			this.currentWordEl.clear();
			this.currentWordEl = null;
		}
		if (this.currentSentenceEl) {
			this.currentSentenceEl.clear();
			this.currentSentenceEl = null;
		}
		if (this.wordHighlightInterval !== null) {
			window.cancelAnimationFrame(this.wordHighlightInterval);
			this.wordHighlightInterval = null;
		}
	}

	onunload() {
		if (this.speaking) {
			this.speechSynthesis.cancel();
		}
		this.clearHighlights();
		if (this.wordHighlightInterval !== null) {
			window.cancelAnimationFrame(this.wordHighlightInterval);
			this.wordHighlightInterval = null;
		}
		this.statusBarEl?.remove();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async getAvailableVoices(): Promise<Array<{ id: string; name: string }>> {
		switch (this.settings.voiceService) {
			case "system":
				// Get system voices
				const sysVoices = this.speechSynthesis.getVoices();
				return sysVoices.map((voice) => ({
					id: voice.voiceURI,
					name: voice.name,
				}));

			case "elevenlabs":
				// Eleven Labs voices
				if (!this.settings.elevenLabsApiKey) {
					return [
						{
							id: "eleven-default",
							name: "Eleven Labs API Key Required",
						},
					];
				}
				return [
					{
						id: "21m00Tcm4TlvDq8ikWAM",
						name: "Rachel (Warm and Professional)",
					},
					{
						id: "AZnzlk1XvdvUeBnXmlld",
						name: "Domi (Strong and Energetic)",
					},
					{
						id: "EXAVITQu4vr4xnSDxMaL",
						name: "Bella (Soft and Gentle)",
					},
					{
						id: "ErXwobaYiN019PkySvjV",
						name: "Antoni (Well-Rounded)",
					},
					{
						id: "MF3mGyEYCl7XYWbV9V6O",
						name: "Elli (Approachable and Friendly)",
					},
					{
						id: "TxGEqnHWrfWFTfGW9XjX",
						name: "Josh (Deep and Clear)",
					},
					{
						id: "VR6AewLTigWG4xSOukaG",
						name: "Arnold (Confident and Rugged)",
					},
					{
						id: "pNInz6obpgDQGcFmaJgB",
						name: "Adam (Professional and Engaging)",
					},
					{
						id: "yoZ06aMxZJJ28mfd3POQ",
						name: "Sam (Serious and Grounded)",
					},
					{
						id: "jsCqWAovK2LkecY7zXl4",
						name: "Emily (Warm and Engaging)",
					},
				];

			case "openai":
				// OpenAI TTS voices
				if (!this.settings.openAIApiKey) {
					return [
						{
							id: "openai-default",
							name: "OpenAI API Key Required",
						},
					];
				}
				return [
					{ id: "alloy", name: "Alloy (Neutral)" },
					{ id: "echo", name: "Echo (Warm)" },
					{ id: "fable", name: "Fable (Expressive)" },
					{ id: "onyx", name: "Onyx (Deep)" },
					{ id: "nova", name: "Nova (Friendly)" },
					{ id: "shimmer", name: "Shimmer (Clear)" },
				];

			default:
				return [{ id: "default", name: "Default System Voice" }];
		}
	}

	private async skipToParagraph(direction: "next" | "previous") {
		if (!this.speaking) return;

		const oldIndex = this.currentParagraphIndex;
		console.log(`[Debug] Skipping from paragraph ${oldIndex} ${direction}`);

		// Calculate new index
		if (direction === "next") {
			this.currentParagraphIndex = Math.min(
				this.currentParagraphIndex + 1,
				this.paragraphs.length - 1
			);
		} else {
			this.currentParagraphIndex = Math.max(
				this.currentParagraphIndex - 1,
				0
			);
		}

		// Clear current highlights and cancel current speech
		this.clearHighlights();

		// Cancel current speech
		if (this.settings.voiceService === "system") {
			this.speechSynthesis.cancel();
		} else if (this.currentAudio) {
			this.currentAudio.pause();
			this.currentAudio = null;
		}

		// Make sure the speech synthesis is completely reset
		return new Promise<void>((resolve) => {
			const checkSpeechSynthesis = () => {
				if (!this.speechSynthesis.speaking) {
					const view =
						this.app.workspace.getActiveViewOfType(MarkdownView);
					if (!view) return;

					const editor = view.editor;
					const text = editor.getValue();

					// Calculate the absolute position of each paragraph
					let offset = 0;
					const paragraphPositions: {
						start: number;
						end: number;
						text: string;
					}[] = [];

					// Split text by paragraphs and track positions
					const allParagraphs = text.split(/\n\s*\n/);
					for (let i = 0; i < allParagraphs.length; i++) {
						const paragraphText = allParagraphs[i];
						paragraphPositions.push({
							start: offset,
							end: offset + paragraphText.length,
							text: paragraphText,
						});
						// Add length of paragraph and the double newline separator
						offset +=
							paragraphText.length +
							(i < allParagraphs.length - 1 ? 2 : 0);
					}

					// Get the current paragraph's position
					const currentParagraph =
						paragraphPositions[this.currentParagraphIndex];
					if (!currentParagraph) {
						console.error(
							"Invalid paragraph index:",
							this.currentParagraphIndex
						);
						return;
					}

					console.log(`[Debug] Current paragraph position:`, {
						index: this.currentParagraphIndex,
						start: currentParagraph.start,
						end: currentParagraph.end,
						text: currentParagraph.text.substring(0, 50) + "...",
					});

					// Start word highlighting for the new paragraph
					if (
						this.settings.highlightEnabled &&
						this.settings.highlightWord
					) {
						// Initial highlight of the first word
						const firstWord = currentParagraph.text.match(/^\S+/);
						if (firstWord) {
							this.highlightWord(
								this.currentParagraphIndex,
								0,
								firstWord[0].length,
								currentParagraph.start
							);
						}

						// Start word highlighting for the new paragraph
						this.startWordHighlighting(
							currentParagraph.text,
							currentParagraph.start
						);
					}

					// Start speaking from the new paragraph
					const remainingText = this.paragraphs
						.slice(this.currentParagraphIndex)
						.join("\n\n");

					switch (this.settings.voiceService) {
						case "system":
							this.speakWithSystem(remainingText);
							break;
						case "elevenlabs":
							this.speakWithElevenLabs(remainingText);
							break;
						case "openai":
							this.speakWithOpenAI(remainingText);
							break;
					}
					resolve();
				} else {
					setTimeout(checkSpeechSynthesis, 50);
				}
			};
			checkSpeechSynthesis();
		});
	}

	private startWordHighlighting(text: string, paragraphStart: number) {
		// Clear any existing word highlighting
		if (this.currentWordEl) {
			this.currentWordEl.clear();
		}

		// Store the current paragraph index to ensure it doesn't change during highlighting
		const currentParagraphIndex = this.currentParagraphIndex;

		// Split text into words and get their exact positions
		const words: { word: string; start: number; length: number }[] = [];
		let pos = 0;

		// Process the text character by character to get exact word positions
		let currentWord = "";
		let wordStart = 0;

		// Skip leading whitespace
		while (pos < text.length && /\s/.test(text[pos])) {
			pos++;
		}
		wordStart = pos;

		for (let i = pos; i < text.length; i++) {
			const char = text[i];
			if (/\s/.test(char)) {
				if (currentWord) {
					words.push({
						word: currentWord,
						start: wordStart,
						length: currentWord.length,
					});
					currentWord = "";
				}
				// Skip consecutive whitespace
				while (i + 1 < text.length && /\s/.test(text[i + 1])) {
					i++;
				}
				wordStart = i + 1;
			} else {
				currentWord += char;
			}
		}

		// Add the last word if exists
		if (currentWord) {
			words.push({
				word: currentWord,
				start: wordStart,
				length: currentWord.length,
			});
		}

		let currentIndex = 0;
		let lastTimestamp = 0;
		let isPaused = false;

		// Clear any existing interval
		if (this.wordHighlightInterval !== null) {
			window.cancelAnimationFrame(this.wordHighlightInterval);
			this.wordHighlightInterval = null;
		}

		// Calculate average word duration based on text length and playback speed
		const averageWordDuration =
			(text.length / words.length) * (60 / this.settings.playbackSpeed);

		// Create an animation frame loop for smoother timing
		const updateHighlight = (timestamp: number) => {
			// Check if we're still on the same paragraph
			if (
				!this.speaking ||
				currentIndex >= words.length ||
				this.currentParagraphIndex !== currentParagraphIndex
			) {
				this.wordHighlightInterval = null;
				return;
			}

			// Check if audio is paused
			const isAudioPaused =
				this.settings.voiceService === "system"
					? this.speechSynthesis.paused
					: this.currentAudio?.paused;

			if (isAudioPaused) {
				// If just paused, store the state
				if (!isPaused) {
					isPaused = true;
					lastTimestamp = timestamp;
				}
			} else {
				// If just resumed, adjust the last timestamp
				if (isPaused) {
					isPaused = false;
					lastTimestamp = timestamp - (timestamp - lastTimestamp);
				}

				// Only update highlighting if not paused
				if (
					!isPaused &&
					timestamp - lastTimestamp >= averageWordDuration
				) {
					const word = words[currentIndex];

					// Calculate the absolute position in the document
					const absolutePosition = paragraphStart + word.start;

					console.log(`[Debug] Highlighting word in paragraph:`, {
						paragraphIndex: currentParagraphIndex,
						paragraphStart,
						word: word.word,
						wordStart: word.start,
						absolutePosition,
					});

					this.highlightWord(
						currentParagraphIndex,
						word.start,
						word.length,
						paragraphStart
					);

					currentIndex++;
					lastTimestamp = timestamp;
				}
			}

			// Continue the animation frame loop
			this.wordHighlightInterval =
				window.requestAnimationFrame(updateHighlight);
		};

		// Start the animation frame loop
		this.wordHighlightInterval =
			window.requestAnimationFrame(updateHighlight);
	}

	async testSelectedVoice() {
		const sampleText = "This is a test of the selected voice.";

		switch (this.settings.voiceService) {
			case "system":
				const utterance = new SpeechSynthesisUtterance(sampleText);
				const voices = this.speechSynthesis.getVoices();
				const selectedVoice = voices.find(
					(v) => v.voiceURI === this.settings.playbackVoice
				);
				if (selectedVoice) {
					utterance.voice = selectedVoice;
					utterance.rate = this.settings.playbackSpeed;
					utterance.pitch = this.settings.pitch;
					utterance.volume = this.settings.volume;
					this.speechSynthesis.speak(utterance);
				}
				break;

			case "openai":
				if (!this.settings.openAIApiKey) {
					new Notice("Please enter your OpenAI API key first");
					return;
				}
				new Notice("Testing OpenAI voice...");
				try {
					const response = await fetch(
						"https://api.openai.com/v1/audio/speech",
						{
							method: "POST",
							headers: {
								Authorization: `Bearer ${this.settings.openAIApiKey}`,
								"Content-Type": "application/json",
							},
							body: JSON.stringify({
								model: "tts-1",
								voice: this.settings.playbackVoice,
								input: sampleText,
							}),
						}
					);

					if (!response.ok) {
						throw new Error(
							`HTTP error! status: ${response.status}`
						);
					}

					const audioBlob = await response.blob();
					const audioUrl = URL.createObjectURL(audioBlob);
					const audio = new Audio(audioUrl);
					audio.play();

					// Clean up the URL after playing
					audio.onended = () => URL.revokeObjectURL(audioUrl);
				} catch (error) {
					console.error("Error testing OpenAI voice:", error);
					new Notice(
						"Error testing OpenAI voice. Check console for details."
					);
				}
				break;

			case "elevenlabs":
				if (!this.settings.elevenLabsApiKey) {
					new Notice("Please enter your Eleven Labs API key first");
					return;
				}
				new Notice("Testing Eleven Labs voice...");
				try {
					const response = await fetch(
						`https://api.elevenlabs.io/v1/text-to-speech/${this.settings.playbackVoice}`,
						{
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								"xi-api-key": this.settings.elevenLabsApiKey,
							},
							body: JSON.stringify({
								text: sampleText,
								model_id: "eleven_monolingual_v1",
								voice_settings: {
									stability: 0.5,
									similarity_boost: 0.75,
									speed: this.settings.playbackSpeed,
								},
							}),
						}
					);

					if (!response.ok) {
						throw new Error(
							`HTTP error! status: ${response.status}`
						);
					}

					const audioBlob = await response.blob();
					const audioUrl = URL.createObjectURL(audioBlob);
					const audio = new Audio(audioUrl);
					audio.play();

					// Clean up the URL after playing
					audio.onended = () => URL.revokeObjectURL(audioUrl);
				} catch (error) {
					console.error("Error testing Eleven Labs voice:", error);
					new Notice(
						"Error testing Eleven Labs voice. Check console for details."
					);
				}
				break;
		}
	}

	getDefaultSystemVoice(): string {
		const voices = this.speechSynthesis.getVoices();
		const defaultVoice = voices.find((v) => v.default) || voices[0];
		return defaultVoice?.voiceURI || "default";
	}
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.setText("Woah!");
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class TextToSpeechSettingTab extends PluginSettingTab {
	plugin: TextToSpeechPlugin;

	constructor(app: App, plugin: TextToSpeechPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Voice Service Section
		containerEl.createEl("h3", { text: "Voice Service" });

		new Setting(containerEl)
			.setName("Default Voice Service")
			.setDesc(
				"Choose which service to use for text-to-speech. 'System Native' uses your operating system's built-in voices (Windows, macOS, or Linux), while Eleven Labs and OpenAI provide high-quality AI voices (requires API key)."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						system: "System Native",
						elevenlabs: "Eleven Labs",
						openai: "OpenAI",
					})
					.setValue(this.plugin.settings.voiceService)
					.onChange(async (value) => {
						const newService = value as
							| "system"
							| "elevenlabs"
							| "openai";
						this.plugin.settings.voiceService = newService;

						// Set default voice based on service
						switch (newService) {
							case "openai":
								this.plugin.settings.playbackVoice = "alloy"; // Default OpenAI voice
								break;
							case "elevenlabs":
								this.plugin.settings.playbackVoice =
									"21m00Tcm4TlvDq8ikWAM"; // Rachel voice ID
								break;
							case "system":
								this.plugin.settings.playbackVoice =
									this.plugin.getDefaultSystemVoice();
								break;
						}

						await this.plugin.saveSettings();
						// Refresh available voices when service changes
						this.display();
					})
			);

		// Add API Key fields based on selected service
		if (this.plugin.settings.voiceService === "elevenlabs") {
			new Setting(containerEl)
				.setName("Eleven Labs API Key")
				.setDesc("Enter your Eleven Labs API key")
				.addText((text) =>
					text
						.setPlaceholder("Enter API key")
						.setValue(this.plugin.settings.elevenLabsApiKey)
						.onChange(async (value) => {
							this.plugin.settings.elevenLabsApiKey = value;
							await this.plugin.saveSettings();
						})
				);
		}

		if (this.plugin.settings.voiceService === "openai") {
			new Setting(containerEl)
				.setName("OpenAI API Key")
				.setDesc(
					"Enter your OpenAI API key. You can find or create your API key at https://platform.openai.com/api-keys"
				)
				.addText((text) =>
					text
						.setPlaceholder("Enter API key")
						.setValue(this.plugin.settings.openAIApiKey)
						.onChange(async (value) => {
							this.plugin.settings.openAIApiKey = value;
							await this.plugin.saveSettings();
						})
				);
		}

		// Playback Settings Section
		containerEl.createEl("h3", { text: "Playback Settings" });

		// Voice selection
		new Setting(containerEl)
			.setName("Voice")
			.setDesc("Select the voice to use for reading")
			.addDropdown(async (dropdown) => {
				const voices = await this.plugin.getAvailableVoices();
				const voiceOptions: Record<string, string> = {};
				voices.forEach((voice) => {
					voiceOptions[voice.id] = voice.name;
				});

				dropdown
					.addOptions(voiceOptions)
					.setValue(this.plugin.settings.playbackVoice)
					.onChange(async (value) => {
						this.plugin.settings.playbackVoice = value;
						await this.plugin.saveSettings();
					});
			})
			.addButton((button) => {
				button
					.setIcon("play-circle")
					.setTooltip("Test selected voice")
					.onClick(() => {
						this.plugin.testSelectedVoice();
					});
				return button;
			});

		// Playback speed
		new Setting(containerEl)
			.setName("Playback Speed")
			.setDesc("Adjust the reading speed (0.5x to 2x)")
			.addSlider((slider) =>
				slider
					.setLimits(0.5, 2, 0.1)
					.setValue(this.plugin.settings.playbackSpeed)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.playbackSpeed = value;
						await this.plugin.saveSettings();
					})
			)
			.addExtraButton((button) => {
				const displayEl = createEl("span", {
					text: this.plugin.settings.playbackSpeed.toFixed(1) + "x",
				});
				button.extraSettingsEl.replaceWith(displayEl);
				return button;
			});

		// Volume control
		new Setting(containerEl)
			.setName("Volume")
			.setDesc("Adjust the playback volume")
			.addSlider((slider) =>
				slider
					.setLimits(0, 1, 0.1)
					.setValue(this.plugin.settings.volume)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.volume = value;
						await this.plugin.saveSettings();
					})
			);

		// Text Highlighting Section
		containerEl.createEl("h3", { text: "Text Highlighting" });

		new Setting(containerEl)
			.setName("Enable Highlighting")
			.setDesc("Toggle word highlighting feature")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.highlightEnabled)
					.onChange(async (value) => {
						this.plugin.settings.highlightEnabled = value;
						await this.plugin.saveSettings();
						// Refresh to show/hide other highlight settings
						this.display();
					})
			);

		if (this.plugin.settings.highlightEnabled) {
			// Word highlighting
			new Setting(containerEl)
				.setName("Highlight Words")
				.setDesc("Highlight each word as it's spoken")
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.highlightWord)
						.onChange(async (value) => {
							this.plugin.settings.highlightWord = value;
							await this.plugin.saveSettings();
						})
				)
				.addColorPicker((color) =>
					color
						.setValue(this.plugin.settings.wordColor)
						.onChange(async (value) => {
							this.plugin.settings.wordColor = value;
							await this.plugin.saveSettings();
						})
				);

			// Add highlight style selector
			new Setting(containerEl)
				.setName("Highlight Style")
				.setDesc("Choose how text is highlighted")
				.addDropdown((dropdown) =>
					dropdown
						.addOptions({
							underline: "Underline",
							background: "Background Color",
						})
						.setValue(this.plugin.settings.highlightStyle)
						.onChange(async (value) => {
							this.plugin.settings.highlightStyle = value as
								| "background"
								| "underline";
							await this.plugin.saveSettings();
						})
				);

			// Add animation toggle
			new Setting(containerEl)
				.setName("Animate Highlights")
				.setDesc("Add smooth transitions to highlights")
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.highlightAnimation)
						.onChange(async (value) => {
							this.plugin.settings.highlightAnimation = value;
							await this.plugin.saveSettings();
						})
				);
		}

		// Add Report Issues Section
		containerEl.createEl("h3", { text: "Help & Support" });

		const reportContainer = containerEl.createDiv();
		reportContainer.addClass("tts-report-container");

		const reportText = reportContainer.createEl("p");
		reportText.setText(
			"Found a bug or have a feature request? Please report it on GitHub:"
		);

		const reportLink = reportContainer.createEl("a", {
			text: "gndclouds/reader-for-obsidian",
			href: "https://github.com/gndclouds/reader-for-obsidian/issues",
		});
		reportLink.addClass("tts-report-link");
	}
}
