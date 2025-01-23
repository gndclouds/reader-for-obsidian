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
	highlightParagraph: boolean;
	highlightSentence: boolean;
	highlightWord: boolean;
	paragraphColor: string;
	sentenceColor: string;
	wordColor: string;
	elevenLabsApiKey: string;
	openAIApiKey: string;
	highlightStyle: "background" | "underline" | "box";
	highlightAnimation: boolean;
}

const DEFAULT_SETTINGS: TextToSpeechSettings = {
	voiceService: "system",
	playbackVoice: "default",
	playbackSpeed: 1.0,
	pitch: 1.0,
	volume: 1.0,
	highlightEnabled: true,
	highlightParagraph: true,
	highlightSentence: true,
	highlightWord: true,
	paragraphColor: "rgba(255, 255, 0, 0.2)",
	sentenceColor: "rgba(255, 255, 0, 0.3)",
	wordColor: "rgba(255, 255, 0, 0.5)",
	elevenLabsApiKey: "",
	openAIApiKey: "",
	highlightStyle: "background",
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
			const isPlaying =
				this.speaking &&
				(this.settings.voiceService === "system"
					? !this.speechSynthesis.paused
					: this.currentAudio && !this.currentAudio.paused);

			playPauseButton.innerHTML = isPlaying
				? `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`
				: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
		}

		playPauseButton.addEventListener("click", async () => {
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

			if (this.speaking) {
				// Handle pause/resume for all services
				if (this.settings.voiceService === "system") {
					if (this.speechSynthesis.paused) {
						this.speechSynthesis.resume();
						this.updateStatusBar("");
					} else {
						this.speechSynthesis.pause();
						this.updateStatusBar("");
					}
				} else if (this.currentAudio) {
					if (this.currentAudio.paused) {
						await this.currentAudio.play();
						this.updateStatusBar("");
					} else {
						this.currentAudio.pause();
						this.updateStatusBar("");
					}
				}
			} else {
				// Start new playback
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
			// Use the selected voice service
			switch (this.settings.voiceService) {
				case "system":
					await this.speakWithSystem(text);
					break;
				case "elevenlabs":
					await this.speakWithElevenLabs(text);
					break;
				case "openai":
					await this.speakWithOpenAI(text);
					break;
			}
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
			console.log("Available voices:", voices);

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
					const wordLength = event.charLength || 1;

					// Get the word being spoken
					const word = paragraph.substring(
						wordIndex,
						wordIndex + wordLength
					);

					// Only highlight if it's an actual word (not whitespace)
					if (word.trim().length > 0) {
						this.highlightWord(
							this.currentParagraphIndex,
							wordIndex,
							wordLength
						);
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
					if (
						this.settings.highlightEnabled &&
						this.settings.highlightWord
					) {
						this.startWordHighlighting(paragraph);
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

				// Handle word highlighting if enabled
				if (this.settings.highlightEnabled) {
					this.highlightParagraph(this.currentParagraphIndex);
				}

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
					if (
						this.settings.highlightEnabled &&
						this.settings.highlightWord
					) {
						this.startWordHighlighting(paragraph);
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

				// Handle word highlighting if enabled
				if (this.settings.highlightEnabled) {
					this.highlightParagraph(this.currentParagraphIndex);
				}

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

		switch (this.settings.highlightStyle) {
			case "background":
				css = `background-color: ${color}; border-radius: 3px; ${transition}`;
				break;
			case "underline":
				css = `border-bottom: 2px solid ${color}; ${transition}`;
				break;
			case "box":
				css = `box-shadow: 0 0 0 1px ${color}; border-radius: 3px; ${transition}`;
				break;
			default:
				css = `background-color: ${color}; border-radius: 3px; ${transition}`;
		}

		console.log("Generated CSS:", css);
		return { css };
	}

	private highlightParagraph(paragraphIndex: number) {
		if (
			!this.settings.highlightEnabled ||
			!this.settings.highlightParagraph
		) {
			return;
		}

		this.clearHighlights();

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const editor = view.editor;
		const text = editor.getValue();
		const paragraphs = text.split(/\n\s*\n/);

		if (paragraphIndex >= paragraphs.length) return;

		let startOffset = 0;
		for (let i = 0; i < paragraphIndex; i++) {
			startOffset += paragraphs[i].length + 2;
		}

		const startPos = editor.offsetToPos(startOffset);
		const endPos = editor.offsetToPos(
			startOffset + paragraphs[paragraphIndex].length
		);
		const style = this.getHighlightStyle(this.settings.paragraphColor);

		try {
			const cmEditor = (editor as any).cm;
			if (!cmEditor) {
				console.warn("CodeMirror editor instance not found");
				return;
			}

			if (typeof cmEditor.markText === "function") {
				// CM5
				this.currentParagraphEl = cmEditor.markText(startPos, endPos, {
					css: style.css,
				});
			} else {
				// CM6
				const editorView = cmEditor;
				const highlightClass = "tts-highlighted-paragraph";

				// Add the style to the document if it doesn't exist
				const styleEl =
					document.getElementById("tts-highlight-styles") ||
					(() => {
						const el = document.createElement("style");
						el.id = "tts-highlight-styles";
						document.head.appendChild(el);
						return el;
					})();
				styleEl.textContent = `.${highlightClass} { ${style.css} }`;

				// Create a decoration for the paragraph
				const fromPos =
					editorView.state.doc.line(startPos.line).from + startPos.ch;
				const toPos =
					editorView.state.doc.line(endPos.line).from + endPos.ch;

				try {
					const decorationField = editorView.state.field(
						(editorView.state as any).decorationField
					);
					if (decorationField) {
						const decoration = decorationField.createDeco({
							from: fromPos,
							to: toPos,
							class: highlightClass,
						});

						editorView.dispatch({
							effects: [decoration],
						});

						this.currentParagraphEl = {
							clear: () => {
								editorView.dispatch({
									effects: [decoration.map(() => null)],
								});
							},
						};
						return;
					}
				} catch (decorationError) {
					console.warn("Error applying decoration:", decorationError);
				}

				// Fallback to DOM-based highlighting
				const editorEl = view.contentEl.querySelector(".cm-content");
				if (editorEl) {
					const mark = document.createElement("mark");
					mark.className = highlightClass;
					editorEl.appendChild(mark);

					this.currentParagraphEl = {
						clear: () => mark.remove(),
					};
				}
			}
		} catch (error) {
			console.warn("Error applying paragraph highlight:", error);
		}
	}

	private highlightWord(
		paragraphIndex: number,
		wordStart: number,
		wordLength: number
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
		const paragraphs = text.split(/\n\s*\n/);

		// Calculate the offset to the current paragraph
		let startOffset = 0;
		for (let i = 0; i < paragraphIndex; i++) {
			startOffset += paragraphs[i].length + 2;
		}

		// Calculate positions for the word
		const from = editor.offsetToPos(startOffset + wordStart);
		const to = editor.offsetToPos(startOffset + wordStart + wordLength);

		// Apply the highlight style
		const style = this.getHighlightStyle(this.settings.wordColor);

		try {
			const cmEditor = (editor as any).cm;
			if (!cmEditor) {
				console.warn("CodeMirror editor instance not found");
				return;
			}

			if (typeof cmEditor.markText === "function") {
				// CM5
				this.currentWordEl = cmEditor.markText(from, to, {
					css: style.css,
					clearOnEnter: false,
				});
			} else {
				// CM6
				const editorView = cmEditor;

				// Create a decoration range
				const fromPos =
					editorView.state.doc.line(from.line).from + from.ch;
				const toPos = editorView.state.doc.line(to.line).from + to.ch;

				// Create a decoration using the StateEffect API
				const highlightEffect = editorView.state.effect.define();
				const transaction = editorView.state.update({
					effects: highlightEffect.of({
						from: fromPos,
						to: toPos,
						spec: {
							attributes: { style: style.css },
						},
					}),
				});

				editorView.dispatch(transaction);

				// Store reference for cleanup
				this.currentWordEl = {
					clear: () => {
						const removeEffect = editorView.state.effect.define();
						editorView.dispatch(
							editorView.state.update({
								effects: removeEffect.of(null),
							})
						);
					},
				};
			}
		} catch (error) {
			console.warn("Error applying word highlight:", error);

			// If all else fails, try using selection highlight
			try {
				const selection = {
					from: editor.offsetToPos(startOffset + wordStart),
					to: editor.offsetToPos(
						startOffset + wordStart + wordLength
					),
				};
				editor.setSelection(selection.from, selection.to);

				this.currentWordEl = {
					clear: () => {
						editor.setSelection(editor.getCursor());
					},
				};
			} catch (selectionError) {
				console.warn(
					"Error applying selection highlight:",
					selectionError
				);
			}
		}
	}

	private highlightSentence(
		paragraphIndex: number,
		sentenceStart: number,
		sentenceLength: number
	) {
		if (
			!this.settings.highlightEnabled ||
			!this.settings.highlightSentence
		) {
			return;
		}

		if (this.currentSentenceEl) {
			this.currentSentenceEl.clear();
		}

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const editor = view.editor;
		const text = editor.getValue();
		const paragraphs = text.split(/\n\s*\n/);

		let startOffset = 0;
		for (let i = 0; i < paragraphIndex; i++) {
			startOffset += paragraphs[i].length + 2;
		}

		const from = editor.offsetToPos(startOffset + sentenceStart);
		const to = editor.offsetToPos(
			startOffset + sentenceStart + sentenceLength
		);
		const style = this.getHighlightStyle(this.settings.sentenceColor);

		try {
			const cmEditor = (editor as any).cm;
			if (!cmEditor) {
				console.warn("CodeMirror editor instance not found");
				return;
			}

			if (typeof cmEditor.markText === "function") {
				// CM5
				this.currentSentenceEl = cmEditor.markText(from, to, {
					css: style.css,
				});
			} else {
				// CM6
				const editorView = cmEditor;
				const highlightClass = "tts-highlighted-sentence";

				// Add the style to the document if it doesn't exist
				const styleEl =
					document.getElementById("tts-highlight-styles") ||
					(() => {
						const el = document.createElement("style");
						el.id = "tts-highlight-styles";
						document.head.appendChild(el);
						return el;
					})();
				styleEl.textContent = `.${highlightClass} { ${style.css} }`;

				// Create a decoration for the sentence
				const fromPos =
					editorView.state.doc.line(from.line).from + from.ch;
				const toPos = editorView.state.doc.line(to.line).from + to.ch;

				try {
					const decorationField = editorView.state.field(
						(editorView.state as any).decorationField
					);
					if (decorationField) {
						const decoration = decorationField.createDeco({
							from: fromPos,
							to: toPos,
							class: highlightClass,
						});

						editorView.dispatch({
							effects: [decoration],
						});

						this.currentSentenceEl = {
							clear: () => {
								editorView.dispatch({
									effects: [decoration.map(() => null)],
								});
							},
						};
						return;
					}
				} catch (decorationError) {
					console.warn("Error applying decoration:", decorationError);
				}

				// Fallback to DOM-based highlighting
				const editorEl = view.contentEl.querySelector(".cm-content");
				if (editorEl) {
					const mark = document.createElement("mark");
					mark.className = highlightClass;
					editorEl.appendChild(mark);

					this.currentSentenceEl = {
						clear: () => mark.remove(),
					};
				}
			}
		} catch (error) {
			console.warn("Error applying sentence highlight:", error);
		}
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
			window.clearInterval(this.wordHighlightInterval);
			this.wordHighlightInterval = null;
		}
	}

	onunload() {
		if (this.speaking) {
			this.speechSynthesis.cancel();
		}
		this.clearHighlights();
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
					// Start speaking from the new paragraph using the selected service
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

	private startWordHighlighting(text: string) {
		const words = text.split(/\s+/);
		let currentIndex = 0;

		// Clear any existing interval
		if (this.wordHighlightInterval !== null) {
			window.clearInterval(this.wordHighlightInterval);
		}

		// Calculate average word duration based on text length and playback speed
		const averageWordDuration =
			(text.length / words.length) * (60 / this.settings.playbackSpeed);

		this.wordHighlightInterval = window.setInterval(() => {
			if (!this.speaking || currentIndex >= words.length) {
				if (this.wordHighlightInterval !== null) {
					window.clearInterval(this.wordHighlightInterval);
					this.wordHighlightInterval = null;
				}
				return;
			}

			// Find the word's position in the original text
			let wordStart = 0;
			for (let i = 0; i < currentIndex; i++) {
				wordStart += words[i].length + 1; // +1 for the space
			}

			this.highlightWord(
				this.currentParagraphIndex,
				wordStart,
				words[currentIndex].length
			);
			currentIndex++;
		}, averageWordDuration);
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
			.setDesc("Toggle all text highlighting features")
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
			// Paragraph highlighting
			new Setting(containerEl)
				.setName("Highlight Paragraphs")
				.setDesc("Highlight the current paragraph being read")
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.highlightParagraph)
						.onChange(async (value) => {
							this.plugin.settings.highlightParagraph = value;
							await this.plugin.saveSettings();
						})
				)
				.addColorPicker((color) =>
					color
						.setValue(this.plugin.settings.paragraphColor)
						.onChange(async (value) => {
							this.plugin.settings.paragraphColor = value;
							await this.plugin.saveSettings();
						})
				);

			// Sentence highlighting
			new Setting(containerEl)
				.setName("Highlight Sentences")
				.setDesc("Highlight the current sentence being read")
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.highlightSentence)
						.onChange(async (value) => {
							this.plugin.settings.highlightSentence = value;
							await this.plugin.saveSettings();
						})
				)
				.addColorPicker((color) =>
					color
						.setValue(this.plugin.settings.sentenceColor)
						.onChange(async (value) => {
							this.plugin.settings.sentenceColor = value;
							await this.plugin.saveSettings();
						})
				);

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
							background: "Background Color",
							underline: "Underline",
							box: "Box Around Text",
						})
						.setValue(this.plugin.settings.highlightStyle)
						.onChange(async (value) => {
							this.plugin.settings.highlightStyle = value as
								| "background"
								| "underline"
								| "box";
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
