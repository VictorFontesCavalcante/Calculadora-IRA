const { jsPDF } = window.jspdf;

import * as pdfjsLib from "./lib/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./lib/pdfjs/pdf.worker.min.mjs";

const GRADES = {
    SS: { value: 5, approved: true },
    MS: { value: 4, approved: true },
    MM: { value: 3, approved: true },
    MI: { value: 2, approved: false },
    II: { value: 1, approved: false },
    SR: { value: 0, approved: false }
};

const COMP_LABELS = {
    "*": "Optativa",
    "e": "Eqv. Obrigatória",
    "&": "Eqv. Optativa",
    "#": "Eletiva",
    "%": "Eqv. Complementar"
};

const INIT_REGEX = /Data da Expedição do Diploma:\s*(\d{4}.\d)/;
const LIMIT_REGEX = /\d{4}.\d.*(\d{4}.\d).*Curso:\s*Currículo:/;
const DISC_REGEX = /(\d{4}\.\d)(?:(?!\d{4}\.\d)[\s\S])*?([A-Z]*) ([A-Z]{3}\d{4})\s*(\d*)\s*\d*\,*\d*\s*([A-Z]{2})*[\s-]*([*e&#])*/g;
const PCNT_REGEX = /Exigido Integralizado Pendente \d* h \d* h \d* h (\d*) h (\d*) h \d* h/;

const state = {
    disciplines: [],
    addedDisciplines: {},
    info: {},
    filename: ""
};

const fileInput = document.getElementById("file-input");
const dropZone = document.getElementById("drop-zone");

const uploadTitle = document.getElementById("upload-title");
const uploadSubtitle = document.getElementById("upload-subtitle");
const uploadFilename = document.getElementById("upload-filename");

const results = document.getElementById("results");
const messages = document.getElementById("messages");

const ira = document.getElementById("ira");
const integration = document.getElementById("integration");

const disciplines = document.getElementById("disciplines");

const futureSection = document.getElementById("future-section");
const futureSemesters = document.getElementById("future-semesters");

function showMessage(message) {
    const element = document.createElement("div");

    messages.innerHTML = "";

    element.className = "message";
    element.textContent = message;

    messages.appendChild(element);
}

function clearMessage() {
    messages.innerHTML = "";
}

function getFutureSemesters(lastSem, limitSem) {

    const [initFirst, initSecond] = lastSem.split(".").map(Number);
    const [targetFirst, targetSecond] = limitSem.split(".").map(Number);

    const addedDisciplines = {};

    let fst = initFirst;
    let snd = initSecond;

    while (fst !== targetFirst || snd !== targetSecond) {

        snd++;

        if (snd === 3) {
            fst++;
            snd = 1;
        }

        addedDisciplines[`${fst}.${snd}`] = {};
    }

    return addedDisciplines;
}

function calculateSemester(initYear, targetYear) {

    const [initFirst, initSecond] = initYear.split(".").map(Number);
    const [targetFirst, targetSecond] = targetYear.split(".").map(Number);

    return Math.min(6, (targetFirst - initFirst) * 2 + (targetSecond - initSecond) + 1);
}

function calculateIraHours(disciplines, addedDisciplines, initYear) {

    let iraTop = 0;
    let iraBottom = 0;
    let hoursAdded = 0;

    for (const discipline of disciplines) {

        const grade = discipline.grade;

        if (grade !== "-" && GRADES[grade]) {

            const semester = calculateSemester(initYear, discipline.semester);

            iraTop += discipline.hours * GRADES[grade].value * semester;
            iraBottom += discipline.hours * semester;

            if (discipline.situation === "MATR" && GRADES[grade].approved) {
                hoursAdded += discipline.hours;
            }

        }

    }

    if (addedDisciplines) {

        for (const [semester, disciplinesForSemester] of Object.entries(addedDisciplines)) {

            for (const discipline of Object.values(disciplinesForSemester)) {

                const grade = discipline.grade;

                if (grade !== "-" && GRADES[grade] && discipline.hours !== "-") {

                    const hours = Number(discipline.hours);

                    const semesterN = calculateSemester(initYear, semester);

                    iraTop += hours * GRADES[grade].value * semesterN;

                    iraBottom += hours * semesterN;

                    if (GRADES[grade].approved) {
                        hoursAdded += hours;
                    }
                }
            }
        }
    }

    return {ira: iraBottom ? iraTop / iraBottom : 0, hoursAdded};
}

async function getPDFText(file) {

    const buffer = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({data: buffer}).promise;

    let text = "";

    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {

        const page = await doc.getPage(pageNum);
        const data = await page.getTextContent();

        text += data.items.map(s => s.str).join(" ");

        text += " ";
    }

    return text;
}

async function loadDisciplineDatabase() {

    const response = await fetch("load.json", {cache: "no-cache"});

    if (!response.ok) {
        throw new Error();
    }

    return await response.json();
}

async function processFile(file) {

    const text = await getPDFText(file);

    const initYearRegex = text.match(INIT_REGEX);
    const limitYearRegex = text.match(LIMIT_REGEX);
    const percentageRegex = text.match(PCNT_REGEX);

    if (!initYearRegex) {
        throw new Error("Não foi possível encontrar a data de expedição do diploma.");
    }

    if (!limitYearRegex) {
        throw new Error("Não foi possível encontrar a data limite de graduação.");
    }

    if (!percentageRegex) {
        throw new Error("Não foi possível encontrar as cargas horárias.");
    }

    const initYear = initYearRegex[1];
    const limitYear = limitYearRegex[1];
    const hoursNeeded = Number(percentageRegex[1]);
    const hoursCompleted = Number(percentageRegex[2]);

    let courses = {};

    try {
        courses = await loadDisciplineDatabase();
    } catch (err) {
        console.error(err);
    }

    const disciplines = [];

    let match;

    while ((match = DISC_REGEX.exec(text)) !== null) {

        const [, semester, situation, code, hours, grade, type] = match;

        if (!(grade in GRADES) && situation !== "MATR") {
            continue;
        }

        const discipline = courses[code] ?? "";
        const label = COMP_LABELS[type] ?? "Obrigatória";

        disciplines.push({
            discipline: `${discipline} (${label})`,
            semester,
            hours: Number(hours),
            grade,
            situation,
            type
        });
    }

    const addedDisciplines = disciplines.length ? getFutureSemesters(disciplines.at(-1).semester, limitYear) : {};

    return {
        disciplines,
        addedDisciplines,
        info: {
            init_year: initYear,
            limit_year: limitYear,
            hours_needed: hoursNeeded,
            hours_completed: hoursCompleted,
            hours_added: 0
        }
    };
}

function render() {

    const {disciplines, addedDisciplines, info} = state;

    const iraHours = calculateIraHours(disciplines, addedDisciplines, info.init_year);

    ira.textContent = iraHours.ira.toFixed(4);
    info.hours_added = iraHours.hoursAdded;

    const totalHours = info.hours_completed + info.hours_added;
    const percentage = info.hours_needed ? totalHours * 100 / info.hours_needed : 0;

    integration.textContent = `${info.hours_completed} / ` + `${info.hours_needed} ` + `(${percentage.toFixed(0)}%)`;

    renderDisciplines();
    renderFutureSemesters();

    results.hidden = false;
}

function renderDisciplines() {

    disciplines.innerHTML = "";

    let previousSemester = null;
    let group = -1;

    state.disciplines.forEach(
        (discipline, index) => {

            if (discipline.semester !== previousSemester) {
                group++;
                previousSemester = discipline.semester;
            }

            const percentage = state.info.hours_needed ? discipline.hours * 100 / state.info.hours_needed : 0;

            const semesterGroup = document.createElement("tr");
            const semester = document.createElement("td");
            const dspln = document.createElement("td");
            const hours = document.createElement("td");
            const grade = document.createElement("td");
            
            semesterGroup.className = `semester-group-${group % 2}`;

            semester.style.textAlign = "center";
            semester.textContent = discipline.semester;

            dspln.style.whiteSpace = "pre-line";
            dspln.textContent = discipline.discipline;

            hours.style.textAlign = "center";
            hours.textContent = `${discipline.hours} h ` + `[+${percentage.toFixed(2)}%]`;
                
            grade.style.textAlign = "center";

            if (discipline.situation === "MATR") {

                const select = createSelect(discipline.grade);

                select.addEventListener("change", () => {
                    savePosition();

                    state.disciplines[index].grade = select.value;

                    render();

                    loadPosition();
                });

                select.className = `semester-group-${group % 2}`;
                grade.appendChild(select);

            } else {
                grade.textContent = discipline.grade;
            }

            semesterGroup.appendChild(semester);
            semesterGroup.appendChild(dspln);
            semesterGroup.appendChild(hours);
            semesterGroup.appendChild(grade);

            disciplines.appendChild(semesterGroup);
        }
    );

}

function createSelect(selected) {

    const select = document.createElement("select");

    const grades = ["--", "SS", "MS", "MM", "MI", "II", "SR"];

    for (const grade of grades) {

        const option = document.createElement("option");

        option.value = grade;
        option.textContent = grade;
        option.selected = grade === selected;

        select.appendChild(option);
    }

    return select;
}

function renderFutureSemesters() {

    futureSemesters.innerHTML = "";

    const semesters = Object.entries(state.addedDisciplines);

    if (semesters.length === 0) {
        futureSection.hidden = true;

        return;
    }

    futureSection.hidden = false;

    for (const [semester, disciplines] of semesters) {

        const addButton = document.createElement("button");
        const header = document.createElement("div");
        const label = document.createElement("div");
        const div = document.createElement("div");
        const title = document.createElement("h2");

        const nameLabel = document.createElement("h3");
        const hoursLabel = document.createElement("h3");
        const gradeLabel = document.createElement("h3");

        div.className = "future-semester";
        header.className = "semester-header";
        title.textContent = semester;

        addButton.type = "button";
        addButton.textContent = "+";

        addButton.addEventListener("click", () => {
            addDiscipline(semester);

            savePosition();

            render();

            loadPosition();
        });

        header.appendChild(title);
        header.appendChild(addButton);

        div.appendChild(header);

        label.className = "semester-label";

        if (Object.keys(disciplines).length) {
            label.classList.add("visible");
        }

        nameLabel.textContent = "Disciplina";
        hoursLabel.textContent = "Carga Horária";
        gradeLabel.textContent = "Menção";

        label.appendChild(nameLabel);
        label.appendChild(hoursLabel);
        label.appendChild(gradeLabel);

        div.appendChild(label);

        for (const [index, discipline] of Object.entries(disciplines)) {
            renderAddedDiscipline(div, semester, index, discipline);
        }

        futureSemesters.appendChild(div);
    }
}

function renderAddedDiscipline(container, semester, index, discipline) {

    const div = document.createElement("div");

    const name = document.createElement("input");
    const hours = document.createElement("select");
    const grade = createSelect(discipline.grade);

    const remove = document.createElement("button");
    const percentage = document.createElement("span");

    function updatePercentage() {

        if (hours.value !== "-") {

            const value = Number(hours.value);
            const percent = state.info.hours_needed
                ? value * 100 / state.info.hours_needed
                : 0;

            percentage.textContent = `[+${percent.toFixed(2)}%]`;

        } else {

            percentage.textContent = "";
        }
    }

    const hourOptions = [
        "-",
        "15",
        "30",
        "45",
        "60",
        "75",
        "90",
        "105",
        "120"
    ];

    div.className = "added-discipline";

    name.className = "name";
    name.type = "text";
    name.placeholder = "Nome da disciplina (opcional)";
    name.value = discipline.name ?? "";

    hours.className = "hours";
    grade.className = "grade";

    remove.type = "button";
    remove.textContent = "-";

    for (const value of hourOptions) {

        const option = document.createElement("option");

        option.value = value;

        option.textContent = value === "-" ? "--" : `${value}h`;

        option.selected = value === String(discipline.hours);

        hours.appendChild(option);
    }

    name.addEventListener("input", () => {

        state.addedDisciplines[semester][index].name = name.value;

    });

    hours.addEventListener("change", () => {

        state.addedDisciplines[semester][index].hours = hours.value;

        updatePercentage();

        savePosition();

        render();

        loadPosition();
    });

    grade.addEventListener("change", () => {

        state.addedDisciplines[semester][index].grade = grade.value;

        savePosition();

        render();

        loadPosition();
    });

    remove.addEventListener("click", () => {

        delete state.addedDisciplines[semester][index];

        const remaining = Object.values(state.addedDisciplines[semester]);

        state.addedDisciplines[semester] = {};

        remaining.forEach((value, newIndex) => {
            state.addedDisciplines[semester][newIndex] = value;
        });

        savePosition();

        render();

        loadPosition();
    });

    updatePercentage();

    div.appendChild(name);
    div.appendChild(hours);
    div.appendChild(grade);
    div.appendChild(remove);
    div.appendChild(percentage);

    container.appendChild(div);
}

function addDiscipline(semester) {

    const addedDisciplines = state.addedDisciplines[semester];

    const indexes = Object.keys(addedDisciplines).map(Number);

    const index = indexes.length
        ? Math.max(...indexes) + 1
        : 0;

    addedDisciplines[index] = {
        name: "",
        hours: "-",
        grade: "-"
    };
}

function savePosition() {
    sessionStorage.setItem("scrollPosition", String(window.scrollY));
}

function loadPosition() {

    const position = sessionStorage.getItem("scrollPosition");

    if (position !== null) {

        window.scrollTo(0, Number(position));

        sessionStorage.removeItem("scrollPosition");
    }
}

async function uploadFile(file) {

    if (!file) {
        return;
    }

    const isPdf =
        file.type === "application/pdf" ||
        file.name.toLowerCase().endsWith(".pdf");

    if (!isPdf) {

        showMessage("O arquivo selecionado deve ser um PDF.");

        fileInput.value = "";

        return;
    }

    uploadTitle.textContent = "Arquivo selecionado";
    uploadSubtitle.textContent = "Processando...";
    uploadFilename.textContent = file.name;

    dropZone.classList.add("uploading");

    try {

        clearMessage();

        const processedFile = await processFile(file);

        state.disciplines = processedFile.disciplines;
        state.addedDisciplines = processedFile.addedDisciplines;
        state.info = processedFile.info;
        state.filename = file.name;

        render();

        uploadTitle.textContent = "Arquivo processado";
        uploadSubtitle.textContent = "Clique para selecionar outro arquivo";

    } catch (err) {

        console.error(err);

        showMessage("Não foi possível processar o arquivo inserido.");

        uploadTitle.textContent = "Arraste seu arquivo em PDF aqui";
        uploadSubtitle.textContent = "ou clique para selecionar um arquivo";
        uploadFilename.textContent = "";

    } finally {

        dropZone.classList.remove("uploading");
    }
}

function generatePDF() {

    const doc = new jsPDF({
        orientation: "portrait",
        unit: "mm",
        format: "a4"
    });

    doc.setFontSize(18);
    doc.text("Histórico Atualizado - UnB", 14, 18);

    doc.setFontSize(11);

    doc.text(`IRA: ${ira.textContent}`, 14, 28);

    doc.text(
        `Integralização: ${integration.textContent}`,
        14,
        35
    );

    const rows = [];

    for (const discipline of state.disciplines) {

        rows.push([
            discipline.semester,
            discipline.discipline,
            `${discipline.hours} h`,
            discipline.grade
        ]);
    }

    for (const [semester, disciplinesForSemester] of
        Object.entries(state.addedDisciplines)) {

        for (const discipline of Object.values(disciplinesForSemester)) {

            const name = discipline.name?.trim()
                ? discipline.name.trim()
                : "Disciplina sem nome";

            const hours = discipline.hours === "-"
                ? "--"
                : `${discipline.hours} h`;

            const grade = discipline.grade === "-"
                ? "--"
                : discipline.grade;

            rows.push([
                semester,
                name,
                hours,
                grade
            ]);
        }
    }

    autoTable(doc, {
        startY: 43,
        head: [["Semestre", "Disciplina", "Carga Horária", "Menção"]],
        body: rows,
        theme: "grid",

        styles: {
            fontSize: 9,
            cellPadding: 2.5,
            valign: "middle"
        },

        headStyles: {
            fontSize: 9,
            halign: "center"
        },

        columnStyles: {
            0: { cellWidth: 25, halign: "center" },
            1: { cellWidth: 100 },
            2: { cellWidth: 32, halign: "center" },
            3: { cellWidth: 25, halign: "center" }
        }
    });

    doc.save("histórico_atualizado.pdf");
}

fileInput.addEventListener("change", () => {

    if (fileInput.files.length > 0) {
        uploadFile(fileInput.files[0]);
    }
});

dropZone.addEventListener("dragover", event => {

    event.preventDefault();

    dropZone.classList.add("dragover");
});

dropZone.addEventListener("dragleave", event => {

    event.preventDefault();

    dropZone.classList.remove("dragover");
});

dropZone.addEventListener("drop", event => {

    event.preventDefault();

    dropZone.classList.remove("dragover");

    const files = event.dataTransfer.files;

    if (files.length === 0) {
        return;
    }

    uploadFile(files[0]);
});

const downloadPDF = document.getElementById("download-pdf");

downloadPDF.addEventListener("click", generatePDF);

results.hidden = true;
futureSection.hidden = true;