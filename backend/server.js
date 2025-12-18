const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const { spawn } = require('child_process');
const { remark } = require('remark');
const html = require('remark-html').default;
const PptxGenJS = require('pptxgenjs');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/studytree', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-3-haiku';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

const callAI = async (messages, maxTokens = 1500) => {
    if (!OPENROUTER_API_KEY) throw new Error('OpenRouter API key is not configured in .env file.');
    try {
        const response = await axios.post(`${OPENROUTER_BASE_URL}/chat/completions`, {
            model: OPENROUTER_MODEL,
            messages: messages,
            max_tokens: maxTokens,
            temperature: 0.7
        }, {
            headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}` }
        });
        return response.data.choices[0].message.content;
    } catch (error) {
        console.error('AI API Error:', error.response?.data || error.message);
        throw new Error('Failed to communicate with the AI model.');
    }
};

const lectureSchema = new mongoose.Schema({
    title: { type: String, required: true },
    videoPath: String,
    youtubeUrl: String,
    duration: Number,
    transcriptMd: String,
    transcriptHtml: String,
    summaryMd: String,
    summaryHtml: String,
    slides: [{ timestamp: Number, image: String }],
    quizzes: [{ question: String, options: [String], correctAnswer: Number, explanation: String }],
    uploadDate: { type: Date, default: Date.now },
    processingError: String,
    source: { type: String, enum: ['file', 'youtube'], default: 'file' },
    processingStage: { type: String, default: 'uploaded' }
});
const Lecture = mongoose.model('Lecture', lectureSchema);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

const downloadYouTubeVideo = (url, lectureId) => new Promise((resolve, reject) => {
    const videoPath = `uploads/${lectureId}-youtube.mp4`;
    console.log(`📺 Downloading YouTube video with yt-dlp: ${url}`);
    const ytdlp = spawn('yt-dlp', ['-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/mp4/best', '-o', videoPath, url]);
    ytdlp.stdout.on('data', (data) => console.log(`yt-dlp: ${data}`));
    ytdlp.stderr.on('data', (data) => console.error(`yt-dlp stderr: ${data}`));
    ytdlp.on('close', (code) => {
        if (code === 0) {
            console.log('✅ YouTube video downloaded successfully.');
            resolve(videoPath);
        } else {
            reject(new Error(`yt-dlp failed with code ${code}`));
        }
    });
    ytdlp.on('error', (err) => reject(new Error(`Failed to start yt-dlp: ${err.message}`)));
});

const transcribeWithWhisper = (audioPath) => new Promise((resolve, reject) => {
    console.log(`🎙️  Transcribing with Whisper: ${audioPath}`);
    const whisper = spawn('whisper', [audioPath, '--model', 'base', '--output_format', 'txt', '--output_dir', path.dirname(audioPath), '--language', 'en']);
    let errorOutput = '';
    whisper.stderr.on('data', (data) => { errorOutput += data.toString(); console.log('Whisper info:', data.toString().trim()); });
    whisper.on('close', (code) => {
        if (code === 0) {
            const txtPath = path.join(path.dirname(audioPath), path.basename(audioPath, path.extname(audioPath)) + '.txt');
            if (fs.existsSync(txtPath)) {
                const transcript = fs.readFileSync(txtPath, 'utf8');
                fs.unlinkSync(txtPath);
                resolve(transcript.trim());
            } else { reject(new Error('Whisper output file not found')); }
        } else { reject(new Error(`Whisper failed: ${errorOutput}`)); }
    });
    whisper.on('error', (err) => reject(new Error(`Failed to start Whisper: ${err.message}`)));
});

const formatTranscript = async (rawTranscript) => {
    console.log('✍️  Formatting transcript with AI...');
    const maxLength = 8000;
    let processedTranscript = rawTranscript;
    if (rawTranscript.length > maxLength) {
        console.log(`⚠️  Transcript too long (${rawTranscript.length} chars), truncating to ${maxLength}...`);
        processedTranscript = rawTranscript.substring(0, maxLength) + '\n\n[... transcript truncated ...]';
    }
    try {
        const formatted = await callAI([{ role: "user", content: `Format this raw transcript by adding paragraph breaks for readability. Do not change any words:\n\n${processedTranscript}` }], 3000);
        if (!formatted || formatted.trim().length < 50 || /^[;:\.\-_\s]+$/.test(formatted)) {
            console.warn('⚠️  AI returned invalid formatted transcript, using raw transcript');
            return rawTranscript;
        }
        return formatted;
    } catch (error) {
        console.error('❌ Transcript formatting failed:', error.message);
        return rawTranscript;
    }
};

const generateFallbackSummary = (transcript) => {
    const sentences = transcript.match(/[^.!?]+[.!?]+/g) || [];
    const firstFew = sentences.slice(0, 5).join(' ');
    return `## Summary\n\nThis lecture covers the following topics:\n\n${firstFew}\n\n*Note: Full AI summary unavailable. Please refer to the transcript for complete details.*`;
};

const generateSummary = async (transcript) => {
    console.log('📝 Generating summary with AI...');
    const maxLength = 6000;
    let processedTranscript = transcript;
    if (transcript.length > maxLength) {
        console.log(`⚠️  Transcript too long for summary (${transcript.length} chars), using first ${maxLength}...`);
        processedTranscript = transcript.substring(0, maxLength) + '\n\n[... content continues ...]';
    }
    try {
        const summary = await callAI([{ role: "user", content: `Create a comprehensive summary of this transcript. Use markdown headings (##) and bullet points (-):\n\n${processedTranscript}` }], 1500);
        if (!summary || summary.trim().length < 50 || /^[;:\.\-_\s]+$/.test(summary)) {
            console.warn('⚠️  AI returned invalid summary, generating fallback');
            return generateFallbackSummary(processedTranscript);
        }
        console.log('✅ Summary generated successfully');
        return summary;
    } catch (error) {
        console.error('❌ Summary generation failed:', error.message);
        return generateFallbackSummary(processedTranscript);
    }
};

const generateQuizzes = async (transcript) => {
    console.log('❓ Generating intelligent quiz with AI...');
    const maxLength = 4000;
    let processedTranscript = transcript;
    if (transcript.length > maxLength) {
        console.log(`⚠️  Transcript too long for quiz (${transcript.length} chars), using first ${maxLength}...`);
        processedTranscript = transcript.substring(0, maxLength) + '\n\n[... content continues ...]';
    }
    let lastResponse = '';
    const quizPrompt = `Based on this transcript, create 5 multiple-choice questions to test understanding.

**RULES:**
1. Focus on key concepts and main ideas
2. Each question must have exactly 4 options
3. correctAnswer must be a number (0, 1, 2, or 3)
4. Provide a brief explanation

Return ONLY a valid JSON array:
[{"question": "...", "options": ["A", "B", "C", "D"], "correctAnswer": 0, "explanation": "..."}]

Transcript: ${processedTranscript}`;

    for (let i = 0; i < 3; i++) {
        try {
            const messages = [{ role: "user", content: i === 0 ? quizPrompt : `Fix this JSON and return ONLY the corrected array:\n\n${lastResponse}` }];
            const response = await callAI(messages, 1500);
            lastResponse = response;
            const startIndex = response.indexOf('{');
            const endIndex = response.lastIndexOf('}');
            if (startIndex === -1 || endIndex === -1) throw new Error("No JSON found");
            let jsonString = response.substring(startIndex, endIndex + 1);
            const trimmedString = jsonString.trim();
            if (trimmedString.startsWith('{') && !trimmedString.startsWith('[')) {
                jsonString = `[${jsonString}]`;
            }
            let quizzes = JSON.parse(jsonString);
            quizzes = quizzes.filter(quiz => {
                if (!quiz.question || !quiz.options || !Array.isArray(quiz.options)) return false;
                if (quiz.options.length !== 4) return false;
                return true;
            }).map(quiz => {
                if (typeof quiz.correctAnswer === 'string') quiz.correctAnswer = parseInt(quiz.correctAnswer, 10);
                if (isNaN(quiz.correctAnswer) || quiz.correctAnswer < 0 || quiz.correctAnswer > 3) quiz.correctAnswer = 0;
                if (!quiz.explanation) quiz.explanation = "Refer to the lecture for details.";
                return quiz;
            }).slice(0, 5);
            if (quizzes.length === 0) throw new Error("No valid quizzes");
            quizzes.forEach(quiz => {
                const correctAnswerText = quiz.options[quiz.correctAnswer];
                quiz.options.sort(() => Math.random() - 0.5);
                quiz.correctAnswer = quiz.options.indexOf(correctAnswerText);
            });
            console.log(`✅ Generated ${quizzes.length} valid quizzes`);
            return quizzes;
        } catch (e) {
            console.warn(`Quiz attempt ${i + 1} failed:`, e.message);
            if (i === 2) {
                console.error("❌ All quiz attempts failed");
                return [];
            }
        }
    }
    return [];
};

const extractAudio = (videoPath) => new Promise((resolve, reject) => {
    const audioPath = videoPath.replace(path.extname(videoPath), '.wav');
    ffmpeg(videoPath).output(audioPath).audioCodec('pcm_s16le').audioFrequency(16000).audioChannels(1)
        .on('end', () => resolve(audioPath))
        .on('error', (err) => reject(err))
        .run();
});

const getVideoDuration = (videoPath) => new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) return reject(err);
        resolve(metadata.format.duration);
    });
});

const getIntelligentSlideTimestamps = async (transcript, duration) => {
    console.log('🧠 Using AI to identify slide transitions...');
    const prompt = `Analyze this lecture transcript and identify 8-12 key moments where a new slide or topic begins.

For each transition point, estimate its position as a percentage (0-100) of the lecture.

Return ONLY a JSON array of percentages (numbers between 0 and 100).

Example: [0, 15, 28, 42, 58, 67, 81, 95]

Transcript:
${transcript.substring(0, 5000)}`;

    try {
        const response = await callAI([{ role: "user", content: prompt }], 500);
        const startIndex = response.indexOf('[');
        const endIndex = response.lastIndexOf(']');
        if (startIndex === -1 || endIndex === -1) throw new Error("No array found");
        const jsonString = response.substring(startIndex, endIndex + 1);
        const percentages = JSON.parse(jsonString);
        if (!Array.isArray(percentages)) throw new Error("Not an array");
        const timestamps = percentages.map(p => Math.floor((p / 100) * duration)).filter(t => t >= 0 && t <= duration).sort((a, b) => a - b);
        if (timestamps[0] !== 0) timestamps.unshift(0);
        const minGap = 15;
        const filtered = [timestamps[0]];
        for (let i = 1; i < timestamps.length; i++) {
            if (timestamps[i] - filtered[filtered.length - 1] >= minGap) {
                filtered.push(timestamps[i]);
            }
        }
        console.log(`✅ AI identified ${filtered.length} slide positions`);
        console.log(`   Timestamps: ${filtered.map(t => `${Math.floor(t)}s`).join(', ')}`);
        return filtered;
    } catch (error) {
        console.error('AI slide detection failed:', error.message);
        return null;
    }
};

const getRuleBasedSlideTimestamps = (transcript, duration) => {
    console.log('📋 Using rule-based slide detection...');
    const sentences = transcript.match(/[^.!?]+[.!?]+/g) || [];
    if (sentences.length === 0) {
        console.warn('⚠️  No sentences found in transcript');
        return null;
    }
    const transitionPhrases = [
        /^now\b/i, /^next\b/i, /^so\b/i, /^let'?s\b/i, /^first\b/i, /^second\b/i,
        /^however\b/i, /^but\b/i, /^finally\b/i, /^in conclusion\b/i,
        /what is\b/i, /how does\b/i, /why\b/i, /the main\b/i
    ];
    const timestamps = [0];
    const minGap = 20;
    let lastTimestamp = 0;
    sentences.forEach((sentence, index) => {
        const position = (index / sentences.length) * duration;
        if (position - lastTimestamp < minGap) return;
        const hasTransition = transitionPhrases.some(pattern => pattern.test(sentence.trim()));
        if (hasTransition) {
            timestamps.push(Math.floor(position));
            lastTimestamp = position;
        }
    });
    if (timestamps.length < 5) {
        console.warn('⚠️  Found too few transitions, adding periodic samples');
        const interval = duration / 7;
        for (let i = 1; i < 7; i++) {
            const t = Math.floor(interval * i);
            if (!timestamps.includes(t)) timestamps.push(t);
        }
        timestamps.sort((a, b) => a - b);
    }
    console.log(`✅ Rule-based detection found ${timestamps.length} slides`);
    console.log(`   Timestamps: ${timestamps.map(t => `${Math.floor(t)}s`).join(', ')}`);
    return timestamps;
};

const extractFramesAtTimestamps = (videoPath, lectureId, timestamps) => new Promise(async (resolve, reject) => {
    console.log(`🎞️  Extracting ${timestamps.length} frames...`);
    const framesDir = `uploads/frames_${lectureId}`;
    if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir);
    const slideData = [];
    const framePromises = timestamps.map((timestamp, index) => {
        return new Promise((resolveFrame) => {
            const filename = `slide_${String(index + 1).padStart(3, '0')}.png`;
            const filePath = path.join(framesDir, filename);
            const webPath = `/frames_${lectureId}/${filename}`;
            ffmpeg(videoPath).seekInput(timestamp).frames(1).size('1280x720').outputOptions('-q:v', '2').output(filePath)
                .on('end', () => { slideData.push({ timestamp: Math.floor(timestamp), image: webPath }); resolveFrame(); })
                .on('error', (err) => { console.error(`Error at ${timestamp}s: ${err.message}`); resolveFrame(); })
                .run();
        });
    });
    try {
        await Promise.all(framePromises);
        slideData.sort((a, b) => a.timestamp - b.timestamp);
        console.log(`✅ Extracted ${slideData.length} frames successfully`);
        resolve(slideData);
    } catch (error) {
        reject(error);
    }
});

const processLecture = async (lectureId, videoPath, title) => {
    try {
        await Lecture.findByIdAndUpdate(lectureId, { processingStage: 'extracting_audio' });
        const audioPath = await extractAudio(videoPath);
        await Lecture.findByIdAndUpdate(lectureId, { processingStage: 'transcribing' });
        const rawTranscript = await transcribeWithWhisper(audioPath);
        const transcript = await formatTranscript(rawTranscript);
        const transcriptHtml = String(await remark().use(html).process(transcript));
        await Lecture.findByIdAndUpdate(lectureId, { processingStage: 'summarizing', transcriptMd: transcript, transcriptHtml });
        const summary = await generateSummary(transcript);
        const summaryHtml = String(await remark().use(html).process(summary));
        const quizzes = await generateQuizzes(transcript);
        const duration = await getVideoDuration(videoPath);
        console.log(`📹 Video duration: ${Math.floor(duration / 60)}m ${Math.floor(duration % 60)}s`);
        let timestamps = null;
        await Lecture.findByIdAndUpdate(lectureId, { processingStage: 'extracting_slides' });
        try {
            console.log('📍 Strategy 1: AI-powered detection...');
            timestamps = await getIntelligentSlideTimestamps(rawTranscript, duration);
            if (!timestamps || timestamps.length < 4) throw new Error('AI returned too few slides');
            console.log('✅ Using AI-detected timestamps');
        } catch (aiError) {
            console.warn(`⚠️  AI detection failed: ${aiError.message}`);
            try {
                console.log('📍 Strategy 2: Rule-based detection...');
                timestamps = getRuleBasedSlideTimestamps(transcript, duration);
                if (!timestamps || timestamps.length < 4) throw new Error('Rule-based returned too few slides');
                console.log('✅ Using rule-based timestamps');
            } catch (ruleError) {
                console.warn(`⚠️  Rule-based failed: ${ruleError.message}`);
                console.log('📍 Strategy 3: Periodic fallback...');
                const slideCount = Math.min(10, Math.max(6, Math.floor(duration / 40)));
                timestamps = Array.from({ length: slideCount }, (_, i) => Math.floor((duration / (slideCount - 1)) * i));
                console.log('✅ Using periodic timestamps');
            }
        }
        console.log(`🎬 Extracting ${timestamps.length} slides...`);
        const slides = await extractFramesAtTimestamps(videoPath, lectureId, timestamps);
        await Lecture.findByIdAndUpdate(lectureId, { summaryMd: summary, summaryHtml, quizzes, slides, processingStage: 'complete', processingError: null });
        console.log(`🎉 Processing Complete!`);
        console.log(`   📊 Slides: ${slides.length}, Quizzes: ${quizzes.length}`);
        if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    } catch (error) {
        console.error(`❌ PROCESSING ERROR for lecture ${lectureId}:`, error.message);
        await Lecture.findByIdAndUpdate(lectureId, { processingError: error.message, processingStage: 'failed' });
    }
};

const processYouTubeLecture = async (lectureId, youtubeUrl, title) => {
    try {
        await Lecture.findByIdAndUpdate(lectureId, { processingStage: 'downloading' });
        const videoPath = await downloadYouTubeVideo(youtubeUrl, lectureId);
        await Lecture.findByIdAndUpdate(lectureId, { videoPath });
        await processLecture(lectureId, videoPath, title);
    } catch (error) {
        console.error(`❌ YOUTUBE PROCESSING ERROR:`, error.message);
        await Lecture.findByIdAndUpdate(lectureId, { processingError: error.message, processingStage: 'failed' });
    }
};

app.post('/api/upload', upload.single('video'), async (req, res) => {
    const lecture = new Lecture({ title: req.body.title || req.file.originalname, videoPath: req.file.path, source: 'file' });
    await lecture.save();
    processLecture(lecture._id, lecture.videoPath, lecture.title);
    res.json({ message: 'Processing started!', lectureId: lecture._id });
});

app.post('/api/upload-youtube', async (req, res) => {
    const { title, youtubeUrl } = req.body;
    const lecture = new Lecture({ title, youtubeUrl, source: 'youtube' });
    await lecture.save();
    processYouTubeLecture(lecture._id, youtubeUrl, title);
    res.json({ message: 'Processing started!', lectureId: lecture._id });
});

app.get('/api/lectures', async (req, res) => res.json(await Lecture.find().sort({ uploadDate: -1 })));
app.get('/api/lectures/:id', async (req, res) => res.json(await Lecture.findById(req.params.id)));

app.get('/api/status/:lectureId', async (req, res) => {
    const lecture = await Lecture.findById(req.params.lectureId);
    if (!lecture) return res.status(404).json({ error: 'Lecture not found' });
    res.json({ isComplete: lecture.processingStage === 'complete', stage: lecture.processingStage, error: lecture.processingError, hasTranscript: !!lecture.transcriptMd, hasSummary: !!lecture.summaryMd, hasQuizzes: !!lecture.quizzes?.length, hasSlides: !!lecture.slides?.length });
});

app.get('/api/lectures/:id/download-ppt', async (req, res) => {
    try {
        const lecture = await Lecture.findById(req.params.id);
        if (!lecture) return res.status(404).json({ error: 'Lecture not found.' });
        if (!lecture.slides || lecture.slides.length === 0) return res.status(404).json({ error: 'No slides found.' });
        console.log(`📊 Generating PPT: ${lecture.title}`);
        const pptx = new PptxGenJS();
        pptx.layout = 'LAYOUT_WIDE';
        const titleSlide = pptx.addSlide();
        titleSlide.background = { color: '2575fc' };
        titleSlide.addText(lecture.title, { x: 0.5, y: 2.5, w: '90%', h: 1.5, align: 'center', fontSize: 44, bold: true, color: 'FFFFFF' });
        titleSlide.addText(`Generated by Study Tree`, { x: 0.5, y: 4, w: '90%', align: 'center', fontSize: 16, color: 'FFFFFF', italic: true });
        let successCount = 0, failCount = 0;
        for (const [index, slide] of lecture.slides.entries()) {
            try {
                let imagePath;
                if (slide.image.startsWith('/uploads/')) imagePath = path.join(__dirname, slide.image.substring(1));
                else if (slide.image.startsWith('/frames_')) imagePath = path.join(__dirname, 'uploads', slide.image.substring(1));
                else if (slide.image.startsWith('frames_')) imagePath = path.join(__dirname, 'uploads', slide.image);
                else imagePath = path.join(__dirname, 'uploads', slide.image);
                if (fs.existsSync(imagePath)) {
                    const slideObj = pptx.addSlide();
                    const minutes = Math.floor(slide.timestamp / 60);
                    const seconds = String(slide.timestamp % 60).padStart(2, '0');
                    slideObj.addText(`Timestamp: ${minutes}:${seconds}`, { x: 0.5, y: 0.2, w: '90%', fontSize: 14, color: '666666', align: 'right' });
                    slideObj.addImage({ path: imagePath, x: '5%', y: '12%', w: '90%', h: '80%', sizing: { type: 'contain', w: '90%', h: '80%' } });
                    successCount++;
                } else {
                    failCount++;
                    const slideObj = pptx.addSlide();
                    slideObj.addText('Image Not Available', { x: 1, y: 2.5, w: 8, h: 1, align: 'center', fontSize: 32, color: 'CCCCCC' });
                }
            } catch (slideError) {
                console.error(`Error processing slide ${index + 1}:`, slideError.message);
                failCount++;
            }
        }
        console.log(`📊 PPT: ${successCount} slides added, ${failCount} failed`);
        if (successCount === 0) return res.status(500).json({ error: 'No slides could be added' });
        const buffer = await pptx.write({ outputType: 'nodebuffer' });
        const safeTitle = lecture.title.replace(/[^a-z0-9\s-]/gi, '').replace(/\s+/g, '_').toLowerCase().substring(0, 50);
        const fileName = `${safeTitle}_slides.pptx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Length', buffer.length);
        res.send(buffer);
        console.log(`✅ PPT sent: ${fileName}`);
    } catch (error) {
        console.error('❌ PPT Generation Error:', error);
        res.status(500).json({ error: 'Failed to generate presentation', details: error.message });
    }
});

app.post('/api/chat/:lectureId', async (req, res) => {
    try {
        const { question } = req.body;
        const lecture = await Lecture.findById(req.params.lectureId);
        if (!lecture || !lecture.transcriptMd) return res.status(404).json({ error: 'Transcript not found' });
        const messages = [
            { role: "system", content: "You are a helpful teaching assistant. Answer questions based ONLY on the provided lecture transcript." },
            { role: "user", content: `Transcript:\n"${lecture.transcriptMd}"\n\nQuestion:\n${question}` }
        ];
        const answer = await callAI(messages, 800);
        res.json({ answer });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get response from chatbot' });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`\n🌳 Study Tree Server running on port ${PORT}`);
    console.log(`   Transcription: Whisper (Local & FREE)`);
    console.log(`   AI Engine: OpenRouter API`);
    console.log(`   Slide Detection: Intelligent 3-Strategy System`);
});

module.exports = app;