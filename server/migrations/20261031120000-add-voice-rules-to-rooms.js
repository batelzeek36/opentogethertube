"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
	async up(queryInterface, Sequelize) {
		await queryInterface.addColumn("Rooms", "voiceEnabled", {
			type: Sequelize.BOOLEAN,
			allowNull: false,
			defaultValue: true,
		});
		await queryInterface.addColumn("Rooms", "voiceMaxTalkSeconds", {
			type: Sequelize.INTEGER,
			allowNull: false,
			defaultValue: 10,
		});
		await queryInterface.addColumn("Rooms", "voiceSlowModeSeconds", {
			type: Sequelize.INTEGER,
			allowNull: false,
			defaultValue: 0,
		});
	},

	async down(queryInterface) {
		await queryInterface.removeColumn("Rooms", "voiceEnabled");
		await queryInterface.removeColumn("Rooms", "voiceMaxTalkSeconds");
		await queryInterface.removeColumn("Rooms", "voiceSlowModeSeconds");
	},
};
