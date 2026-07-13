package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	defaultDeepgramModel = "nova-3"
	defaultOpenAIModel   = "gpt-4o-transcribe"
)

type result struct {
	OK          bool            `json:"ok"`
	Provider    string          `json:"provider"`
	Model       string          `json:"model"`
	File        string          `json:"file"`
	DurationMS  int64           `json:"duration_ms"`
	Transcript  string          `json:"transcript"`
	Confidence  *float64        `json:"confidence,omitempty"`
	Words       int             `json:"words"`
	StatusCode  int             `json:"status_code"`
	Raw         json.RawMessage `json:"raw,omitempty"`
	Error       string          `json:"error,omitempty"`
	ResolvedKey string          `json:"resolved_key,omitempty"`
}

type config struct {
	provider       string
	file           string
	model          string
	language       string
	apiKey         string
	apiKeyFile     string
	timeout        time.Duration
	smartFormat    bool
	raw            bool
	insecureTLS    bool
	deepgramURL    string
	openAIURL      string
	openAIResponse string
}

func main() {
	cfg := parseFlags()
	res, err := run(cfg)
	if err != nil {
		printResult(result{
			OK:       false,
			Provider: cfg.provider,
			Model:    cfg.model,
			File:     cfg.file,
			Error:    err.Error(),
		})
		os.Exit(1)
	}
	printResult(res)
	if !res.OK {
		os.Exit(1)
	}
}

func parseFlags() config {
	var cfg config
	flag.StringVar(&cfg.provider, "provider", "deepgram", "STT provider: deepgram or openai")
	flag.StringVar(&cfg.file, "file", "", "audio file to transcribe")
	flag.StringVar(&cfg.model, "model", "", "provider model override")
	flag.StringVar(&cfg.language, "language", "en", "language code")
	flag.StringVar(&cfg.apiKey, "api-key", "", "API key value; prefer env or --api-key-file")
	flag.StringVar(&cfg.apiKeyFile, "api-key-file", "", "path to API key file")
	flag.DurationVar(&cfg.timeout, "timeout", 45*time.Second, "request timeout")
	flag.BoolVar(&cfg.smartFormat, "smart-format", true, "Deepgram smart_format")
	flag.BoolVar(&cfg.raw, "raw", false, "include raw provider response")
	flag.BoolVar(&cfg.insecureTLS, "insecure-tls", false, "disable TLS verification for debugging")
	flag.StringVar(&cfg.deepgramURL, "deepgram-url", "https://api.deepgram.com/v1/listen", "Deepgram listen endpoint")
	flag.StringVar(&cfg.openAIURL, "openai-url", "https://api.openai.com/v1/audio/transcriptions", "OpenAI transcription endpoint")
	flag.StringVar(&cfg.openAIResponse, "openai-response-format", "json", "OpenAI response_format")
	flag.Parse()

	cfg.provider = strings.ToLower(strings.TrimSpace(cfg.provider))
	if cfg.model == "" {
		switch cfg.provider {
		case "deepgram":
			cfg.model = defaultDeepgramModel
		case "openai":
			cfg.model = defaultOpenAIModel
		}
	}
	return cfg
}

func run(cfg config) (result, error) {
	if cfg.file == "" {
		return result{}, errors.New("missing --file")
	}
	if _, err := os.Stat(cfg.file); err != nil {
		return result{}, fmt.Errorf("audio file not readable: %w", err)
	}
	key, source, err := resolveAPIKey(cfg)
	if err != nil {
		return result{}, err
	}

	started := time.Now()
	var res result
	switch cfg.provider {
	case "deepgram":
		res, err = transcribeDeepgram(cfg, key)
	case "openai":
		res, err = transcribeOpenAI(cfg, key)
	default:
		err = fmt.Errorf("unknown provider %q; use deepgram or openai", cfg.provider)
	}
	if err != nil {
		return result{}, err
	}
	res.DurationMS = time.Since(started).Milliseconds()
	res.Provider = cfg.provider
	res.Model = cfg.model
	res.File = cfg.file
	res.Words = countWords(res.Transcript)
	res.ResolvedKey = source
	return res, nil
}

func resolveAPIKey(cfg config) (string, string, error) {
	if strings.TrimSpace(cfg.apiKey) != "" {
		return strings.TrimSpace(cfg.apiKey), "flag", nil
	}
	if cfg.apiKeyFile != "" {
		key, err := readKeyFile(cfg.apiKeyFile)
		return key, cfg.apiKeyFile, err
	}
	var envNames []string
	switch cfg.provider {
	case "deepgram":
		envNames = []string{"DEEPGRAM_API_KEY"}
	case "openai":
		envNames = []string{"OPENAI_API_KEY"}
	}
	for _, name := range envNames {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value, name, nil
		}
		if file := strings.TrimSpace(os.Getenv(name + "_FILE")); file != "" {
			key, err := readKeyFile(file)
			return key, file, err
		}
	}
	for _, file := range defaultKeyFiles(cfg.provider) {
		if _, err := os.Stat(file); err == nil {
			key, readErr := readKeyFile(file)
			return key, file, readErr
		}
	}
	return "", "", fmt.Errorf("missing API key for %s; set env or pass --api-key-file", cfg.provider)
}

func defaultKeyFiles(provider string) []string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return nil
	}
	switch provider {
	case "deepgram":
		return []string{filepath.Join(home, ".openclaw", "secrets", "deepgram-api-key")}
	case "openai":
		return []string{filepath.Join(home, ".openclaw", "secrets", "openai-api-key")}
	default:
		return nil
	}
}

func readKeyFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read API key file: %w", err)
	}
	key := strings.TrimSpace(string(data))
	if key == "" {
		return "", fmt.Errorf("API key file is empty: %s", path)
	}
	return key, nil
}

func transcribeDeepgram(cfg config, key string) (result, error) {
	audio, err := os.ReadFile(cfg.file)
	if err != nil {
		return result{}, err
	}
	endpoint, err := url.Parse(cfg.deepgramURL)
	if err != nil {
		return result{}, err
	}
	q := endpoint.Query()
	q.Set("model", cfg.model)
	q.Set("language", cfg.language)
	q.Set("smart_format", fmt.Sprintf("%t", cfg.smartFormat))
	endpoint.RawQuery = q.Encode()

	req, err := http.NewRequest(http.MethodPost, endpoint.String(), bytes.NewReader(audio))
	if err != nil {
		return result{}, err
	}
	req.Header.Set("Authorization", "Token "+key)
	req.Header.Set("Content-Type", contentTypeForFile(cfg.file))

	body, status, err := doRequest(cfg, req)
	if err != nil {
		return result{}, err
	}
	res := result{OK: status >= 200 && status < 300, StatusCode: status}
	if !res.OK {
		res.Error = providerError(body)
		return res, nil
	}

	var parsed struct {
		Results struct {
			Channels []struct {
				Alternatives []struct {
					Transcript string  `json:"transcript"`
					Confidence float64 `json:"confidence"`
				} `json:"alternatives"`
			} `json:"channels"`
		} `json:"results"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return result{}, fmt.Errorf("parse Deepgram response: %w", err)
	}
	if len(parsed.Results.Channels) > 0 && len(parsed.Results.Channels[0].Alternatives) > 0 {
		alt := parsed.Results.Channels[0].Alternatives[0]
		res.Transcript = strings.TrimSpace(alt.Transcript)
		conf := alt.Confidence
		res.Confidence = &conf
	}
	if cfg.raw {
		res.Raw = json.RawMessage(body)
	}
	return res, nil
}

func transcribeOpenAI(cfg config, key string) (result, error) {
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	fileWriter, err := writer.CreateFormFile("file", filepath.Base(cfg.file))
	if err != nil {
		return result{}, err
	}
	file, err := os.Open(cfg.file)
	if err != nil {
		return result{}, err
	}
	defer file.Close()
	if _, err := io.Copy(fileWriter, file); err != nil {
		return result{}, err
	}
	_ = writer.WriteField("model", cfg.model)
	_ = writer.WriteField("language", cfg.language)
	_ = writer.WriteField("response_format", cfg.openAIResponse)
	_ = writer.Close()

	req, err := http.NewRequest(http.MethodPost, cfg.openAIURL, &buf)
	if err != nil {
		return result{}, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", writer.FormDataContentType())

	body, status, err := doRequest(cfg, req)
	if err != nil {
		return result{}, err
	}
	res := result{OK: status >= 200 && status < 300, StatusCode: status}
	if !res.OK {
		res.Error = providerError(body)
		return res, nil
	}
	var parsed struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return result{}, fmt.Errorf("parse OpenAI response: %w", err)
	}
	res.Transcript = strings.TrimSpace(parsed.Text)
	if cfg.raw {
		res.Raw = json.RawMessage(body)
	}
	return res, nil
}

func doRequest(cfg config, req *http.Request) ([]byte, int, error) {
	client := &http.Client{
		Timeout: cfg.timeout,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: cfg.insecureTLS}, //nolint:gosec // explicit debug flag only
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return body, resp.StatusCode, nil
}

func contentTypeForFile(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".wav":
		return "audio/wav"
	case ".mp3":
		return "audio/mpeg"
	case ".m4a":
		return "audio/mp4"
	case ".ogg":
		return "audio/ogg"
	case ".webm":
		return "audio/webm"
	case ".flac":
		return "audio/flac"
	default:
		return "application/octet-stream"
	}
}

func providerError(body []byte) string {
	var parsed any
	if json.Unmarshal(body, &parsed) == nil {
		encoded, _ := json.Marshal(parsed)
		return string(encoded)
	}
	text := strings.TrimSpace(string(body))
	if text == "" {
		return "empty error response"
	}
	return text
}

func countWords(text string) int {
	return len(strings.Fields(text))
}

func printResult(res result) {
	encoded, err := json.MarshalIndent(res, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "marshal result: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(string(encoded))
}
