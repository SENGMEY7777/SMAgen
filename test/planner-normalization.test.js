const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LOCAL_DESKTOP_OUTPUT = 'true';

const {
    completeExplicitProjectTreePlan,
    normalizePlan,
    validatePlan,
} = require('../core/planner');
const dbPool = require('../configs/db');

test.after(async () => {
    await dbPool.end();
});

test('clamps an overlong workflow title before schema validation', () => {
    const plan = {
        workflowTitle: 'Production E-Commerce REST API '.repeat(12),
        summary: 'Create the requested API.',
        tasks: [{
            nodeKey: 'task_1',
            title: 'Create project',
            instruction: 'Create the project files.',
            dependencies: [],
            assignedTool: 'fileManager',
            toolInput: {},
        }],
    };

    const normalized = normalizePlan(plan);
    const validation = validatePlan(plan);

    assert.equal(normalized.workflowTitle.length, 255);
    assert.equal(validation.success, true);
});

test('treats an explicit project tree as required and does not delete src for clean architecture wording', () => {
    const goalPrompt = `Goal: Create a production-grade E-Commerce REST API from scratch using Node.js and MySQL.
Target Destination: Create directly on my Mac Desktop in a folder named "E-Commerce-API" (Path: ~/Desktop/E-Commerce-API).
Initialize a clean package.json with the requested dependencies.
Folder Structure & Clean Layered Architecture:
├── database/
│   ├── schema.sql
│   └── seed.sql
├── src/
│   ├── configs/
│   │   ├── db.js
│   │   └── env.js
│   ├── controllers/
│   │   ├── authController.js
│   │   └── productController.js
│   ├── services/
│   │   ├── authService.js
│   │   └── orderService.js
│   ├── routes/
│   │   ├── index.js
│   │   └── authRoutes.js
│   ├── middlewares/
│   │   ├── authMiddleware.js
│   │   └── errorHandler.js
│   ├── validators/
│   │   ├── authValidator.js
│   │   └── orderValidator.js
│   ├── utils/
│   │   ├── apiError.js
│   │   └── response.js
│   ├── app.js
│   └── server.js
├── .env.example
├── .gitignore
└── README.md
Also create package.json.`;

    const requestedFiles = [
        'database/schema.sql',
        'database/seed.sql',
        'src/configs/db.js',
        'src/configs/env.js',
        'src/controllers/authController.js',
        'src/controllers/productController.js',
        'src/services/authService.js',
        'src/services/orderService.js',
        'src/routes/index.js',
        'src/routes/authRoutes.js',
        'src/middlewares/authMiddleware.js',
        'src/middlewares/errorHandler.js',
        'src/validators/authValidator.js',
        'src/validators/orderValidator.js',
        'src/utils/apiError.js',
        'src/utils/response.js',
        'src/app.js',
        'src/server.js',
        '.env.example',
        '.gitignore',
        'README.md',
        'package.json',
    ];
    const createFileTask = (relativePath, index) => ({
        nodeKey: `file_${index + 1}`,
        title: `Create ${relativePath}`,
        instruction: `Create ${relativePath} with complete implementation.`,
        dependencies: [],
        assignedTool: 'fileManager',
        toolInput: {
            action: 'createDesktopFile',
            path: `E-Commerce-API/${relativePath}`,
            content: relativePath.endsWith('.json') ? '{}' : '// generated',
        },
    });

    const completePlan = {
        workflowTitle: 'E-Commerce API',
        summary: 'Create the requested API.',
        tasks: [
            {
                nodeKey: 'create_project',
                title: 'Create project directory',
                instruction: 'Create E-Commerce-API.',
                dependencies: [],
                assignedTool: 'fileManager',
                toolInput: {
                    action: 'createDesktopDirectory',
                    path: 'E-Commerce-API',
                },
            },
            {
                nodeKey: 'legacy_services',
                title: 'Create services directory',
                instruction: 'Create services at the project root.',
                dependencies: [],
                assignedTool: 'fileManager',
                toolInput: {
                    action: 'createDesktopDirectory',
                    path: 'E-Commerce-API/services',
                },
            },
            ...requestedFiles.map(createFileTask),
        ],
    };

    const normalized = normalizePlan(completePlan, {goalPrompt});
    const normalizedPaths = normalized.tasks.flatMap((task) => (
        Array.isArray(task.toolInput?.files)
            ? task.toolInput.files.map((file) => file.path)
            : task.toolInput?.path ? [task.toolInput.path] : []
    ));

    assert.equal(validatePlan(completePlan, {goalPrompt}).success, true);
    for (const filePath of requestedFiles) {
        assert.equal(normalizedPaths.includes(`E-Commerce-API/${filePath}`), true, filePath);
    }
    assert.equal(normalized.tasks.some((task) => (
        String(task.toolInput?.action || '').toLowerCase() === 'deletedesktoppath'
    )), false);
    assert.equal(normalized.tasks.some((task) => (
        String(task.toolInput?.path || '').toLowerCase() === 'e-commerce-api/services'
    )), false);

    const incompletePlan = {
        ...completePlan,
        tasks: completePlan.tasks.slice(0, 2),
    };
    const incompleteValidation = validatePlan(incompletePlan, {goalPrompt});
    assert.equal(incompleteValidation.success, false);
    assert.match(incompleteValidation.error.message, /database\/seed\.sql/);
});

test('completes missing explicit-tree files in smaller batches', async () => {
    const goalPrompt = `Create a Node.js project on my Desktop in a folder named "Batch-API".
Folder structure:
├── src/
│   ├── app.js
│   └── server.js
└── README.md`;
    const calls = [];
    const basePlan = {
        workflowTitle: 'Batch API',
        summary: 'Create the project.',
        tasks: [{
            nodeKey: 'create_project',
            title: 'Create project directory',
            instruction: 'Create Batch-API.',
            dependencies: [],
            assignedTool: 'fileManager',
            toolInput: {
                action: 'createDesktopDirectory',
                path: 'Batch-API',
            },
        }],
    };

    const completedPlan = await completeExplicitProjectTreePlan({
        basePlan,
        goalPrompt,
        generateStructure: async ({userPrompt}) => {
            calls.push(userPrompt);
            const paths = [...userPrompt.matchAll(/^- (.+)$/gm)].map((match) => match[1]);
            return {
                data: {
                    workflowTitle: 'Batch API',
                    summary: 'Create the project.',
                    tasks: paths.map((filePath, index) => ({
                        nodeKey: `generated_${index + 1}`,
                        title: `Create ${filePath}`,
                        instruction: `Create ${filePath}.`,
                        dependencies: [],
                        assignedTool: 'fileManager',
                        toolInput: {
                            action: 'createDesktopFile',
                            path: filePath,
                            content: '// generated content',
                        },
                    })),
                },
            };
        },
    });

    assert.equal(validatePlan(completedPlan, {goalPrompt}).success, true);
    assert.equal(calls.length, 1);
});

test('completes larger explicit trees in bounded concurrent batches', async () => {
    const goalPrompt = `Create a Node.js project on my Desktop in a folder named "Concurrent-API".
Folder structure:
├── src/
│   ├── app.js
│   ├── server.js
│   ├── config.js
│   ├── routes.js
│   ├── service.js
│   ├── model.js
│   └── validator.js`;
    const calls = [];
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const basePlan = {
        workflowTitle: 'Concurrent API',
        summary: 'Create the project.',
        tasks: [{
            nodeKey: 'create_project',
            title: 'Create project directory',
            instruction: 'Create Concurrent-API.',
            dependencies: [],
            assignedTool: 'fileManager',
            toolInput: {
                action: 'createDesktopDirectory',
                path: 'Concurrent-API',
            },
        }],
    };

    const completedPlan = await completeExplicitProjectTreePlan({
        basePlan,
        goalPrompt,
        generateStructure: async ({userPrompt, maxTransientRetries, timeoutMs}) => {
            assert.equal(maxTransientRetries, 0);
            assert.equal(timeoutMs, 10000);
            calls.push(userPrompt);
            activeCalls += 1;
            maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
            await new Promise((resolve) => setTimeout(resolve, 5));
            const paths = [...userPrompt.matchAll(/^- (.+)$/gm)].map((match) => match[1]);
            activeCalls -= 1;
            return {
                data: {
                    workflowTitle: 'Concurrent API',
                    summary: 'Create the project.',
                    tasks: paths.map((filePath, index) => ({
                        nodeKey: `generated_${index + 1}`,
                        title: `Create ${filePath}`,
                        instruction: `Create ${filePath}.`,
                        dependencies: [],
                        assignedTool: 'fileManager',
                        toolInput: {
                            action: 'createDesktopFile',
                            path: filePath,
                            content: '// generated content',
                        },
                    })),
                },
            };
        },
    });

    assert.equal(validatePlan(completedPlan, {goalPrompt}).success, true);
    assert.equal(calls.length, 3);
    assert.equal(maxActiveCalls, 3);
});
