const fs = require('fs');
const mysql = require('mysql2/promise');
const readline = require('readline');
require('dotenv').config();

// Database configuration
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT
};

// API.video URL patterns
const generateVideoUrls = (videoId) => {
    return {
        lesson_url: `https://vod.api.video/vod/${videoId}/hls/manifest.m3u8`,
        lesson_thumbnail_url: `https://vod.api.video/vod/${videoId}/thumbnail.jpg`,
        downloadable_url: `https://vod.api.video/vod/${videoId}/mp4/source.mp4`
    };
};

// Function to read video IDs from file
const readVideoIdsFromFile = (filePath) => {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return content
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
    } catch (error) {
        console.error('Error reading video IDs file:', error);
        process.exit(1);
    }
};

// Function to prompt user for input
const promptUser = (question) => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
};

// Function to insert lessons into database
const insertLessons = async (videoIds, courseId, titlePrefix, titlePrefixAr, description, descriptionAr) => {
    let connection;
    
    try {
        connection = await mysql.createConnection(dbConfig);
        console.log('Connected to database successfully');

        for (let i = 0; i < videoIds.length; i++) {
            const videoId = videoIds[i];
            const order = i + 1;
            const urls = generateVideoUrls(videoId);
            
            const lessonData = {
                title: `${titlePrefix} - ${order}`,
                title_ar: `${order} - ${titlePrefixAr}`,
                course_id: parseInt(courseId),
                description: `${description} ${order}`,
                description_ar: `الدرس ${order} من ${descriptionAr}`,
                lesson_temp_file: urls.lesson_thumbnail_url,
                lesson_video_id: videoId,
                lesson_url: urls.lesson_url,
                lesson_thumbnail_url: urls.lesson_thumbnail_url,
                lesson_status: 'uploaded',
                order: order,
                created_at: new Date(),
                updated_at: new Date(),
                downloadable_url: urls.downloadable_url,
                is_hidden: 0,
                duration: null
            };

            const insertQuery = `
                INSERT INTO lessons (
                    title, title_ar, course_id, description, description_ar,
                    lesson_temp_file, lesson_video_id, lesson_url, lesson_thumbnail_url,
                    lesson_status, \`order\`, created_at, updated_at, downloadable_url,
                    is_hidden, duration
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;

            const values = [
                lessonData.title,
                lessonData.title_ar,
                lessonData.course_id,
                lessonData.description,
                lessonData.description_ar,
                lessonData.lesson_temp_file,
                lessonData.lesson_video_id,
                lessonData.lesson_url,
                lessonData.lesson_thumbnail_url,
                lessonData.lesson_status,
                lessonData.order,
                lessonData.created_at,
                lessonData.updated_at,
                lessonData.downloadable_url,
                lessonData.is_hidden,
                lessonData.duration
            ];

            await connection.execute(insertQuery, values);
            console.log(`✅ Inserted lesson ${order}: ${lessonData.title} (Video ID: ${videoId})`);
        }

        console.log(`\n🎉 Successfully uploaded ${videoIds.length} lessons to course ${courseId}`);

    } catch (error) {
        console.error('Database error:', error);
        process.exit(1);
    } finally {
        if (connection) {
            await connection.end();
        }
    }
};

// Main function
const main = async () => {
    console.log('📹 Lessons Uploader for API.video\n');

    try {
        // Get file path containing video IDs
        const filePath = await promptUser('Enter the path to your video IDs file: ');
        
        if (!fs.existsSync(filePath)) {
            console.error('❌ File not found:', filePath);
            process.exit(1);
        }

        // Read video IDs
        const videoIds = readVideoIdsFromFile(filePath);
        console.log(`📋 Found ${videoIds.length} video IDs`);

        if (videoIds.length === 0) {
            console.error('❌ No video IDs found in file');
            process.exit(1);
        }

        // Get course information
        const courseId = await promptUser('Enter the course_id: ');
        const titlePrefix = await promptUser('Enter the lesson title prefix (English): ');
        const titlePrefixAr = await promptUser('Enter the lesson title prefix (Arabic): ');
        const description = await promptUser('Enter the lesson description prefix (English): ');
        const descriptionAr = await promptUser('Enter the lesson description prefix (Arabic): ');

        // Confirm before proceeding
        console.log('\n📊 Summary:');
        console.log(`Course ID: ${courseId}`);
        console.log(`Number of lessons: ${videoIds.length}`);
        console.log(`Title format: "${titlePrefix} - 1", "${titlePrefix} - 2", etc.`);
        console.log(`Arabic title format: "1 - ${titlePrefixAr}", "2 - ${titlePrefixAr}", etc.`);
        console.log('\nFirst few video IDs:');
        videoIds.slice(0, 3).forEach((id, index) => {
            console.log(`  ${index + 1}. ${id}`);
        });

        const confirm = await promptUser('\nProceed with upload? (y/N): ');
        
        if (confirm.toLowerCase() !== 'y') {
            console.log('❌ Upload cancelled');
            process.exit(0);
        }

        // Insert lessons
        await insertLessons(videoIds, courseId, titlePrefix, titlePrefixAr, description, descriptionAr);

    } catch (error) {
        console.error('Application error:', error);
        process.exit(1);
    }
};

// Run the application
main(); 